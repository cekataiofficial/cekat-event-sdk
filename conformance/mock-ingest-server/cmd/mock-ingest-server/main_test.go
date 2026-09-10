package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

type mockProcess struct {
	cmd      *exec.Cmd
	ready    readiness
	lines    <-chan string
	scanErrs <-chan error
	stderr   *bytes.Buffer
}

func TestProcessContract(t *testing.T) {
	binary := buildCommand(t)
	process := startProcess(t, binary)
	defer process.stop(t)

	assertReadiness(t, process.ready)
	process.assertNoAdditionalStdout(t)

	post(t, process.ready.ControlURL+"/__control/reset", "")
	post(t, process.ready.ControlURL+"/__control/responses", `{"responses":[{"status":201,"headers":{"X-Reply":"queued"},"body":"queued response"}]}`)

	response, err := http.Post(process.ready.BaseURL+"/api/events/ingest", "application/json", strings.NewReader(`{"event":"example"}`))
	if err != nil {
		t.Fatalf("post ingest: %v", err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatalf("read ingest response: %v", err)
	}
	if response.StatusCode != http.StatusCreated || response.Header.Get("X-Reply") != "queued" || string(body) != "queued response" {
		t.Fatalf("unexpected ingest response: status=%d header=%q body=%q", response.StatusCode, response.Header.Get("X-Reply"), body)
	}

	journalResponse, err := http.Get(process.ready.ControlURL + "/__control/requests")
	if err != nil {
		t.Fatalf("get journal: %v", err)
	}
	defer journalResponse.Body.Close()
	var journal struct {
		Requests []struct {
			Sequence uint64 `json:"sequence"`
			Path     string `json:"path"`
			Body     string `json:"body"`
		} `json:"requests"`
	}
	if err := json.NewDecoder(journalResponse.Body).Decode(&journal); err != nil {
		t.Fatalf("decode journal: %v", err)
	}
	if journalResponse.StatusCode != http.StatusOK || len(journal.Requests) != 1 || journal.Requests[0].Sequence != 1 || journal.Requests[0].Path != "/api/events/ingest" || journal.Requests[0].Body != `{"event":"example"}` {
		t.Fatalf("unexpected journal: status=%d entries=%+v", journalResponse.StatusCode, journal.Requests)
	}

	process.stop(t)
}

func TestProcessesHaveIsolatedState(t *testing.T) {
	binary := buildCommand(t)
	first := startProcess(t, binary)
	defer first.stop(t)
	second := startProcess(t, binary)
	defer second.stop(t)

	post(t, first.ready.ControlURL+"/__control/responses", `{"responses":[{"status":202,"body":"first"}]}`)
	post(t, second.ready.ControlURL+"/__control/responses", `{"responses":[{"status":203,"body":"second"}]}`)

	assertIngestResponse(t, first.ready.BaseURL, http.StatusAccepted, "first")
	assertIngestResponse(t, second.ready.BaseURL, http.StatusNonAuthoritativeInfo, "second")
	assertJournalLength(t, first.ready.ControlURL, 1)
	assertJournalLength(t, second.ready.ControlURL, 1)
}

func TestInvalidFlagsAndListenReportErrors(t *testing.T) {
	binary := buildCommand(t)
	for _, arguments := range [][]string{{"--unknown"}, {"--listen", "not a listener"}} {
		t.Run(strings.Join(arguments, " "), func(t *testing.T) {
			command := exec.Command(binary, arguments...)
			output, err := command.CombinedOutput()
			if err == nil {
				t.Fatalf("arguments %q unexpectedly succeeded", arguments)
			}
			if len(output) == 0 || !strings.Contains(strings.ToLower(string(output)), "listen") && !strings.Contains(strings.ToLower(string(output)), "flag") {
				t.Fatalf("arguments %q produced no useful diagnostic: %q", arguments, output)
			}
		})
	}
}

func buildCommand(t *testing.T) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "mock-ingest-server")
	command := exec.Command("go", "build", "-o", binary, ".")
	command.Dir = "."
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build command: %v\n%s", err, output)
	}
	return binary
}

func startProcess(t *testing.T, binary string) *mockProcess {
	t.Helper()
	command := exec.Command(binary, "--listen", "127.0.0.1:0")
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatalf("open stdout: %v", err)
	}
	stderr := &bytes.Buffer{}
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		t.Fatalf("start command: %v", err)
	}

	lines := make(chan string, 2)
	scanErrs := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
		scanErrs <- scanner.Err()
		close(lines)
	}()

	select {
	case line := <-lines:
		var ready readiness
		if err := json.Unmarshal([]byte(line), &ready); err != nil {
			_ = command.Process.Kill()
			t.Fatalf("decode readiness %q: %v; stderr: %s", line, err, stderr.String())
		}
		return &mockProcess{cmd: command, ready: ready, lines: lines, scanErrs: scanErrs, stderr: stderr}
	case err := <-scanErrs:
		_ = command.Wait()
		t.Fatalf("command exited before readiness: %v; stderr: %s", err, stderr.String())
	case <-time.After(5 * time.Second):
		_ = command.Process.Kill()
		_ = command.Wait()
		t.Fatalf("timed out waiting for readiness; stderr: %s", stderr.String())
	}
	return nil
}

func (process *mockProcess) assertNoAdditionalStdout(t *testing.T) {
	t.Helper()
	select {
	case line, ok := <-process.lines:
		if ok {
			t.Fatalf("unexpected stdout after readiness: %q", line)
		}
		t.Fatalf("command exited before signal; stderr: %s", process.stderr.String())
	case <-time.After(100 * time.Millisecond):
	}
}

func (process *mockProcess) stop(t *testing.T) {
	t.Helper()
	if process.cmd.ProcessState != nil && process.cmd.ProcessState.Exited() {
		return
	}
	if err := process.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("send SIGTERM: %v", err)
	}
	wait := make(chan error, 1)
	go func() { wait <- process.cmd.Wait() }()
	select {
	case err := <-wait:
		if err != nil {
			t.Fatalf("command did not exit cleanly: %v; stderr: %s", err, process.stderr.String())
		}
		for line := range process.lines {
			t.Fatalf("unexpected stdout after readiness: %q", line)
		}
		if err := <-process.scanErrs; err != nil {
			t.Fatalf("read command stdout: %v", err)
		}
	case <-time.After(6 * time.Second):
		_ = process.cmd.Process.Kill()
		_ = process.cmd.Wait()
		t.Fatal("command did not exit within six seconds after SIGTERM")
	}
}

func assertReadiness(t *testing.T, ready readiness) {
	t.Helper()
	base, err := url.Parse(ready.BaseURL)
	if err != nil || base.Scheme != "http" || base.Host == "" || base.Path != "" || base.RawQuery != "" || base.Fragment != "" {
		t.Fatalf("base_url is not an absolute origin: %q (%v)", ready.BaseURL, err)
	}
	control, err := url.Parse(ready.ControlURL)
	if err != nil || control.Scheme != "http" || control.Host != base.Host || control.Path != "" || control.RawQuery != "" || control.Fragment != "" {
		t.Fatalf("control_url is not the same absolute origin: %q (%v)", ready.ControlURL, err)
	}
}

func post(t *testing.T, endpoint, body string) {
	t.Helper()
	response, err := http.Post(endpoint, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post %s: %v", endpoint, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		payload, _ := io.ReadAll(response.Body)
		t.Fatalf("post %s: status=%d body=%q", endpoint, response.StatusCode, payload)
	}
}

func assertIngestResponse(t *testing.T, baseURL string, status int, wantBody string) {
	t.Helper()
	response, err := http.Post(baseURL+"/api/events/ingest", "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatalf("post ingest: %v", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read ingest: %v", err)
	}
	if response.StatusCode != status || string(body) != wantBody {
		t.Fatalf("ingest response: status=%d body=%q; want status=%d body=%q", response.StatusCode, body, status, wantBody)
	}
}

func assertJournalLength(t *testing.T, controlURL string, want int) {
	t.Helper()
	response, err := http.Get(controlURL + "/__control/requests")
	if err != nil {
		t.Fatalf("get journal: %v", err)
	}
	defer response.Body.Close()
	var journal struct {
		Requests []json.RawMessage `json:"requests"`
	}
	if err := json.NewDecoder(response.Body).Decode(&journal); err != nil {
		t.Fatalf("decode journal: %v", err)
	}
	if len(journal.Requests) != want {
		t.Fatalf("journal length=%d, want %d", len(journal.Requests), want)
	}
}
