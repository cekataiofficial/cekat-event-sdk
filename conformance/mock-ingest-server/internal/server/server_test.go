package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cekataiofficial/cekat-event-sdk/conformance/mock-ingest-server/internal/state"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

func TestRoutesRejectWrongMethodsAndUnknownPaths(t *testing.T) {
	srv := httptest.NewServer(New(state.New()))
	defer srv.Close()

	for _, tc := range []struct {
		method, path, allow string
	}{
		{http.MethodGet, "/__control/reset", http.MethodPost},
		{http.MethodGet, "/__control/responses", http.MethodPost},
		{http.MethodPost, "/__control/requests", http.MethodGet},
		{http.MethodGet, "/api/events/ingest", http.MethodPost},
	} {
		req, err := http.NewRequest(tc.method, srv.URL+tc.path, nil)
		if err != nil {
			t.Fatal(err)
		}
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusMethodNotAllowed || response.Header.Get("Allow") != tc.allow {
			t.Errorf("%s %s = (%d, Allow %q), want (405, %q)", tc.method, tc.path, response.StatusCode, response.Header.Get("Allow"), tc.allow)
		}
	}

	response, err := http.Get(srv.URL + "/not-a-route")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown path status = %d, want 404", response.StatusCode)
	}
}

func TestControlResetReplaceAndStrictResponseDecoding(t *testing.T) {
	s := state.New()
	srv := httptest.NewServer(New(s))
	defer srv.Close()

	postJSON(t, srv.URL+"/__control/responses", `{"responses":[{"status":201,"headers":{"X-First":"yes"},"body":"first"},{"status":202,"body":"second"}]}`, http.StatusNoContent)
	postJSON(t, srv.URL+"/api/events/ingest", `{"before":true}`, http.StatusCreated)
	postJSON(t, srv.URL+"/__control/responses", `{"responses":[{"status":203,"body":"replacement"}]}`, http.StatusNoContent)
	postJSON(t, srv.URL+"/api/events/ingest", `{}`, http.StatusNonAuthoritativeInfo)

	requests := journal(t, srv.URL)
	if len(requests.Requests) != 2 {
		t.Fatalf("journal has %d requests, want 2", len(requests.Requests))
	}
	assertJournalSchema(t, requests)

	postJSON(t, srv.URL+"/__control/reset", "", http.StatusNoContent)
	if got := journal(t, srv.URL); len(got.Requests) != 0 {
		t.Fatalf("reset journal = %#v, want no requests", got.Requests)
	}
	postJSON(t, srv.URL+"/api/events/ingest", `{}`, http.StatusOK)

	for _, body := range []string{
		`{}`,
		`{"responses":[],"extra":true}`,
		`{"responses":[{"status":200,"body":"ok","unknown":true}]}`,
		`{"responses":[{"status":199,"body":"ok"}]}`,
		`{"responses":[{"status":200,"headers":{"X-Test":1},"body":"ok"}]}`,
		`{"responses":[{"status":200,"body":"ok","delay_ms":-1}]}`,
		`{"responses":[{"body":"ok"}]}`,
		`{"responses":[{"disconnect_before_headers":false,"body":"ok"}]}`,
		`{"responses":[]} {}`,
	} {
		response := rawPost(t, srv.URL+"/__control/responses", body)
		if response.StatusCode != http.StatusBadRequest {
			t.Errorf("invalid body %s status = %d, want 400", body, response.StatusCode)
		}
		if !strings.HasPrefix(response.Header.Get("Content-Type"), "application/json") {
			t.Errorf("invalid body %s Content-Type = %q, want application/json", body, response.Header.Get("Content-Type"))
		}
		response.Body.Close()
	}

	response := rawPost(t, srv.URL+"/__control/responses", `{"responses":[{"status":200,"body":"ok"}]}`)
	response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("queue valid response = %d, want 204", response.StatusCode)
	}
}

func TestIngestJournalsUnchangedBodyNormalizedHeadersAndFIFO(t *testing.T) {
	srv := httptest.NewServer(New(state.New()))
	defer srv.Close()

	postJSON(t, srv.URL+"/__control/responses", `{"responses":[{"status":201,"headers":{"X-Reply":"one"},"body":"first"},{"status":202,"body":"second"}]}`, http.StatusNoContent)
	body := `{"event_key":"same bytes \u2603"}`
	request, err := http.NewRequest(http.MethodPost, srv.URL+"/api/events/ingest", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header["X-Multi"] = []string{"second", "first"}
	request.Header["x-multi"] = []string{"third"}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	gotBody, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusCreated || string(gotBody) != "first" || response.Header.Get("X-Reply") != "one" {
		t.Fatalf("first response = (%d, %q, %#v)", response.StatusCode, gotBody, response.Header)
	}
	postJSON(t, srv.URL+"/api/events/ingest", "{}", http.StatusAccepted)

	got := journal(t, srv.URL)
	if len(got.Requests) != 2 {
		t.Fatalf("journal length = %d, want 2", len(got.Requests))
	}
	first := got.Requests[0]
	if first.Sequence != 1 || first.Method != http.MethodPost || first.Path != "/api/events/ingest" || first.Body != body {
		t.Fatalf("first journal request = %#v", first)
	}
	if values := first.Headers["x-multi"]; len(values) != 3 || !hasAll(values, "first", "second", "third") {
		t.Fatalf("x-multi = %#v, want all values", values)
	}
	for name := range first.Headers {
		if name != strings.ToLower(name) {
			t.Errorf("journal header %q is not lowercase", name)
		}
	}
}

func TestDelayedIngestStopsWhenClientCancelsAfterJournaling(t *testing.T) {
	srv := httptest.NewServer(New(state.New()))
	defer srv.Close()

	postJSON(t, srv.URL+"/__control/responses", `{"responses":[{"status":200,"body":"late","delay_ms":500}]}`, http.StatusNoContent)
	request, err := http.NewRequest(http.MethodPost, srv.URL+"/api/events/ingest", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("X-Cancelled", "yes")
	context, cancel := context.WithTimeout(request.Context(), 20*time.Millisecond)
	defer cancel()
	request = request.WithContext(context)
	start := time.Now()
	_, err = http.DefaultClient.Do(request)
	if err == nil {
		t.Fatal("cancelled delayed request unexpectedly succeeded")
	}
	if elapsed := time.Since(start); elapsed >= 250*time.Millisecond {
		t.Fatalf("cancelled delayed request took %s, want less than 250ms", elapsed)
	}
	requests := journal(t, srv.URL)
	if len(requests.Requests) != 1 || requests.Requests[0].Headers["x-cancelled"][0] != "yes" {
		t.Fatalf("cancelled request was not journaled before delay: %#v", requests.Requests)
	}
}

func TestEmptyQueueDelayAndDisconnectAfterJournal(t *testing.T) {
	srv := httptest.NewServer(New(state.New()))
	defer srv.Close()

	response := rawPost(t, srv.URL+"/api/events/ingest", `{}`)
	defaultBody, _ := io.ReadAll(response.Body)
	response.Body.Close()
	const wantDefault = `{"success":true,"data":{"success":true,"message":"accepted","event_key":"conformance_default","validated_properties":[]}}`
	if response.StatusCode != http.StatusOK || string(defaultBody) != wantDefault {
		t.Fatalf("default response = (%d, %s)", response.StatusCode, defaultBody)
	}

	postJSON(t, srv.URL+"/__control/responses", `{"responses":[{"status":200,"body":"slow","delay_ms":40}]}`, http.StatusNoContent)
	start := time.Now()
	postJSON(t, srv.URL+"/api/events/ingest", `{}`, http.StatusOK)
	if elapsed := time.Since(start); elapsed < 40*time.Millisecond {
		t.Fatalf("response delay = %s, want at least 40ms", elapsed)
	}

	postJSON(t, srv.URL+"/__control/responses", `{"responses":[{"disconnect_before_headers":true,"body":""}]}`, http.StatusNoContent)
	disconnected, err := http.Post(srv.URL+"/api/events/ingest", "application/json", strings.NewReader(`{}`))
	if disconnected != nil {
		disconnected.Body.Close()
	}
	if err == nil {
		t.Fatal("disconnect request unexpectedly received a response")
	}
	if !errors.Is(err, io.EOF) {
		t.Fatalf("disconnect error = %v, want an io.EOF transport failure", err)
	}
	got := journal(t, srv.URL)
	if len(got.Requests) != 3 {
		t.Fatalf("journal length after disconnect = %d, want 3", len(got.Requests))
	}
}

type journalResponse struct {
	Requests []state.RequestRecord `json:"requests"`
}

func assertJournalSchema(t *testing.T, journal journalResponse) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "fixtures", "schemas", "request-journal.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	compiler := jsonschema.NewCompiler()
	if err := compiler.AddResource("request-journal", document); err != nil {
		t.Fatal(err)
	}
	schema, err := compiler.Compile("request-journal")
	if err != nil {
		t.Fatal(err)
	}
	data, err = json.Marshal(journal)
	if err != nil {
		t.Fatal(err)
	}
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	if err := schema.Validate(value); err != nil {
		t.Fatalf("journal violates request-journal schema: %v", err)
	}
}

func journal(t *testing.T, baseURL string) journalResponse {
	t.Helper()
	response, err := http.Get(baseURL + "/__control/requests")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("journal status = %d", response.StatusCode)
	}
	var got journalResponse
	if err := json.NewDecoder(response.Body).Decode(&got); err != nil {
		t.Fatalf("decode journal: %v", err)
	}
	return got
}

func postJSON(t *testing.T, url, body string, wantStatus int) {
	t.Helper()
	response := rawPost(t, url, body)
	if response == nil {
		t.Fatalf("POST %s failed without an HTTP response", url)
	}
	response.Body.Close()
	if response.StatusCode != wantStatus {
		t.Fatalf("POST %s = %d, want %d", url, response.StatusCode, wantStatus)
	}
}

func rawPost(t *testing.T, url, body string) *http.Response {
	t.Helper()
	response, err := http.Post(url, "application/json", bytes.NewBufferString(body))
	if err == nil {
		return response
	}
	if response != nil {
		return response
	}
	if !strings.Contains(err.Error(), "EOF") && !strings.Contains(err.Error(), "connection reset") {
		t.Fatalf("POST %s: %v, want an EOF-like transport failure", url, err)
	}
	return nil
}

func hasAll(values []string, wants ...string) bool {
	for _, want := range wants {
		found := false
		for _, value := range values {
			if value == want {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
