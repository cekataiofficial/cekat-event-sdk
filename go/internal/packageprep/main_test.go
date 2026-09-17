package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func TestPrepareRejectsInvalidVersionAndOutput(t *testing.T) {
	moduleRoot := testModule(t)
	for _, test := range []struct {
		name    string
		version string
		output  string
	}{
		{name: "wrong version", version: "1.0.0", output: t.TempDir()},
		{name: "relative output", version: packageVersion, output: "relative/output"},
		{name: "traversal output", version: packageVersion, output: filepath.Join(t.TempDir(), "..", "output")},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := prepare(test.version, test.output, moduleRoot); err == nil {
				t.Fatal("prepare succeeded, want an argument validation error")
			}
		})
	}
}

func TestPrepareWritesDeterministicManifestAndTokenFreeArchive(t *testing.T) {
	moduleRoot := testModule(t)
	firstOutput := t.TempDir()
	secondOutput := t.TempDir()
	if err := prepare(packageVersion, firstOutput, moduleRoot); err != nil {
		t.Fatalf("first prepare: %v", err)
	}
	if err := prepare(packageVersion, secondOutput, moduleRoot); err != nil {
		t.Fatalf("second prepare: %v", err)
	}

	firstManifest, firstArchive := readManifestAndArchive(t, firstOutput)
	secondManifest, secondArchive := readManifestAndArchive(t, secondOutput)
	if firstManifest.SchemaVersion != 1 || firstManifest.Language != "go" || firstManifest.Version != packageVersion {
		t.Fatalf("manifest = %#v, want schema version 1, language go, and version %s", firstManifest, packageVersion)
	}
	if len(firstManifest.Artifacts) != 1 {
		t.Fatalf("artifact count = %d, want 1", len(firstManifest.Artifacts))
	}
	paths := make([]string, len(firstManifest.Artifacts))
	for i, artifact := range firstManifest.Artifacts {
		paths[i] = artifact.Path
		contents, err := os.ReadFile(filepath.Join(firstOutput, filepath.FromSlash(artifact.Path)))
		if err != nil {
			t.Fatalf("read artifact %q: %v", artifact.Path, err)
		}
		digest := sha256.Sum256(contents)
		if artifact.SizeBytes != int64(len(contents)) || artifact.SHA256 != hex.EncodeToString(digest[:]) {
			t.Fatalf("artifact %q has inaccurate metadata: %#v", artifact.Path, artifact)
		}
		if strings.ToLower(artifact.SHA256) != artifact.SHA256 || len(artifact.SHA256) != 64 {
			t.Fatalf("artifact hash %q is not lowercase SHA-256", artifact.SHA256)
		}
	}
	if !sort.StringsAreSorted(paths) {
		t.Fatalf("artifact paths are not sorted: %v", paths)
	}
	if !bytes.Equal(firstArchive, secondArchive) || firstManifest.Artifacts[0] != secondManifest.Artifacts[0] {
		t.Fatal("package output is not deterministic")
	}

	archive, err := zip.NewReader(bytes.NewReader(firstArchive), int64(len(firstArchive)))
	if err != nil {
		t.Fatalf("open archive: %v", err)
	}
	archivePaths := make([]string, 0, len(archive.File))
	for _, file := range archive.File {
		archivePaths = append(archivePaths, file.Name)
		if !strings.HasPrefix(file.Name, "golang.cekat.ai/event-sdk@v0.1.0/") {
			t.Errorf("archive path %q does not use the module-version root", file.Name)
		}
		reader, err := file.Open()
		if err != nil {
			t.Fatalf("open archive entry %q: %v", file.Name, err)
		}
		reader.Close()
		if _, err := os.Stat(filepath.Join(moduleRoot, filepath.FromSlash(strings.TrimPrefix(file.Name, "golang.cekat.ai/event-sdk@v0.1.0/")))); err != nil {
			t.Fatalf("archive entry %q is not a tracked source file: %v", file.Name, err)
		}
	}
	if !sort.StringsAreSorted(archivePaths) {
		t.Fatalf("archive paths are not sorted: %v", archivePaths)
	}
	if bytes.Contains(firstArchive, []byte("test-secret-token")) {
		t.Fatal("archive contains a credential token")
	}
	for _, path := range archivePaths {
		if strings.Contains(path, "credentials") || strings.Contains(path, ".env") || strings.Contains(path, "generated/") {
			t.Errorf("archive includes excluded path %q", path)
		}
	}
}

func TestPrepareWritesOneArchivePerPublishableModule(t *testing.T) {
	moduleRoot := testModule(t)
	for path, contents := range map[string]string{
		"middleware/gin/go.mod":        "module golang.cekat.ai/event-sdk/middleware/gin\n\ngo 1.25.0\n",
		"middleware/gin/go.sum":        "",
		"middleware/gin/middleware.go": "package gin\n",
		"internal/conformance/go.mod":  "module golang.cekat.ai/event-sdk/internal/conformance\n\ngo 1.22\n",
		"internal/conformance/case.go": "package conformance\n",
		"internal/shared/shared.go":    "package shared\n",
	} {
		fullPath := filepath.Join(moduleRoot, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(fullPath, []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	git(t, moduleRoot, "add", ".")
	output := t.TempDir()
	if err := prepare(packageVersion, output, moduleRoot); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	manifestBytes, err := os.ReadFile(filepath.Join(output, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest packageManifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		t.Fatal(err)
	}
	want := map[string][]string{
		"cekat-event-sdk-go-middleware-gin-v0.1.0.zip": {
			"golang.cekat.ai/event-sdk/middleware/gin@v0.1.0/go.mod",
			"golang.cekat.ai/event-sdk/middleware/gin@v0.1.0/go.sum",
			"golang.cekat.ai/event-sdk/middleware/gin@v0.1.0/middleware.go",
		},
		"cekat-event-sdk-go-v0.1.0.zip": {
			"golang.cekat.ai/event-sdk@v0.1.0/README.md",
			"golang.cekat.ai/event-sdk@v0.1.0/client.go",
			"golang.cekat.ai/event-sdk@v0.1.0/go.mod",
			"golang.cekat.ai/event-sdk@v0.1.0/internal/shared/shared.go",
			"golang.cekat.ai/event-sdk@v0.1.0/nested/source.go",
		},
	}
	if len(manifest.Artifacts) != len(want) || manifest.Artifacts[0].Path != "cekat-event-sdk-go-middleware-gin-v0.1.0.zip" {
		t.Fatalf("artifacts = %#v, want sorted core and gin archives without internal modules", manifest.Artifacts)
	}
	for _, artifact := range manifest.Artifacts {
		contents, err := os.ReadFile(filepath.Join(output, artifact.Path))
		if err != nil {
			t.Fatal(err)
		}
		archive, err := zip.NewReader(bytes.NewReader(contents), int64(len(contents)))
		if err != nil {
			t.Fatal(err)
		}
		var names []string
		for _, file := range archive.File {
			names = append(names, file.Name)
		}
		if strings.Join(names, "\n") != strings.Join(want[artifact.Path], "\n") {
			t.Errorf("%s entries = %v, want %v", artifact.Path, names, want[artifact.Path])
		}
	}
}

func TestPackageScriptRejectsInvalidArgumentsAndUnsafeOutputs(t *testing.T) {
	output := t.TempDir()
	nonempty := t.TempDir()
	if err := os.WriteFile(filepath.Join(nonempty, "existing"), []byte("not empty"), 0o644); err != nil {
		t.Fatalf("write nonempty output marker: %v", err)
	}
	symlinkTarget := t.TempDir()
	symlink := filepath.Join(t.TempDir(), "output-link")
	if err := os.Symlink(symlinkTarget, symlink); err != nil {
		t.Fatalf("make output symlink: %v", err)
	}

	for _, test := range []struct {
		name string
		args []string
	}{
		{name: "no arguments", args: nil},
		{name: "missing output value", args: []string{"--version", packageVersion, "--output"}},
		{name: "reordered arguments", args: []string{"--output", output, "--version", packageVersion}},
		{name: "wrong version", args: []string{"--version", "1.0.0", "--output", output}},
		{name: "extra argument", args: []string{"--version", packageVersion, "--output", output, "extra"}},
		{name: "relative output", args: []string{"--version", packageVersion, "--output", "relative/output"}},
		{name: "traversal output", args: []string{"--version", packageVersion, "--output", filepath.Join(output, "..", "other")}},
		{name: "nonempty output", args: []string{"--version", packageVersion, "--output", nonempty}},
		{name: "symlink output", args: []string{"--version", packageVersion, "--output", symlink}},
	} {
		t.Run(test.name, func(t *testing.T) {
			command := exec.Command(packageScript(t), test.args...)
			output, err := command.CombinedOutput()
			if err == nil {
				t.Fatalf("package script succeeded with %q", test.args)
			}
			if exitError, ok := err.(*exec.ExitError); !ok || exitError.ExitCode() != 2 {
				t.Fatalf("package script error = %v, output = %s; want exit 2", err, output)
			}
		})
	}
}

func TestPackageScriptIsNoPublishWrapper(t *testing.T) {
	script, err := os.ReadFile(packageScript(t))
	if err != nil {
		t.Fatalf("read package script: %v", err)
	}
	contents := string(script)
	for _, required := range []string{"go test ./...", "go vet ./...", "middleware/gin", "internal/conformance", "go run ./internal/packageprep"} {
		if !strings.Contains(contents, required) {
			t.Errorf("package script does not run %q", required)
		}
	}
	for _, forbidden := range []string{"publish", "sign", " push", " tag", "registry"} {
		if strings.Contains(strings.ToLower(contents), forbidden) {
			t.Errorf("package script contains forbidden release operation %q", forbidden)
		}
	}
}

func TestPrepareExcludesCredentialFiles(t *testing.T) {
	moduleRoot := testModule(t)
	output := t.TempDir()
	if err := prepare(packageVersion, output, moduleRoot); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	_, archiveBytes := readManifestAndArchive(t, output)
	archive, err := zip.NewReader(bytes.NewReader(archiveBytes), int64(len(archiveBytes)))
	if err != nil {
		t.Fatalf("open archive: %v", err)
	}
	entries := make(map[string]bool, len(archive.File))
	for _, file := range archive.File {
		entries[strings.TrimPrefix(file.Name, modulePath+"@v"+packageVersion+"/")] = true
	}
	for _, credentialPath := range []string{
		".netrc",
		".npmrc",
		".pypirc",
		"id_rsa",
		"private.pem",
		"private.key",
		"service-account.json",
		"auth.json",
	} {
		if entries[credentialPath] {
			t.Errorf("archive includes credential path %q", credentialPath)
		}
	}
}

func TestTrackedSourceFilesRejectSymlink(t *testing.T) {
	moduleRoot := testModule(t)
	if err := os.Symlink("client.go", filepath.Join(moduleRoot, "source-link.go")); err != nil {
		t.Fatalf("make source symlink: %v", err)
	}
	git(t, moduleRoot, "add", "source-link.go")
	if _, err := trackedSourceFiles(moduleRoot); err == nil || !strings.Contains(err.Error(), "not a regular file") {
		t.Fatalf("trackedSourceFiles error = %v, want tracked symlink rejection", err)
	}
}

func TestREADMEContract(t *testing.T) {
	readme, err := os.ReadFile(filepath.Join(goModuleRoot(t), "README.md"))
	if err != nil {
		t.Fatalf("read README: %v", err)
	}
	contents := string(readme)
	for _, required := range []string{
		"golang.cekat.ai/event-sdk",
		"Gin v1, Echo v4, Fiber v3, and Chi v5",
		"cekat.New(",
		"context.WithTimeout",
		"WithVisitorID",
		"middleware/nethttp",
		"middleware/gin",
		"middleware/echo",
		"middleware/fiber",
		"middleware/chi",
		"c.Request.Context()",
		"c.Context()",
		"context.WithoutCancel",
		"Retry-After",
		"EventID",
		"errors.As",
		"context.Canceled",
		"duplicate",
		"Acknowledgement",
		"background",
		"UserRegistration",
	} {
		if !strings.Contains(contents, required) {
			t.Errorf("README must document %q", required)
		}
	}
}

func readManifestAndArchive(t *testing.T, output string) (packageManifest, []byte) {
	t.Helper()
	manifestBytes, err := os.ReadFile(filepath.Join(output, "manifest.json"))
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	var manifest packageManifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		t.Fatalf("parse manifest: %v", err)
	}
	if len(manifest.Artifacts) != 1 {
		t.Fatalf("manifest artifacts = %#v", manifest.Artifacts)
	}
	archive, err := os.ReadFile(filepath.Join(output, filepath.FromSlash(manifest.Artifacts[0].Path)))
	if err != nil {
		t.Fatalf("read archive: %v", err)
	}
	return manifest, archive
}

func goModuleRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatalf("resolve module root: %v", err)
	}
	return root
}

func packageScript(t *testing.T) string {
	t.Helper()
	return filepath.Join(goModuleRoot(t), "scripts", "package")
}

func testModule(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for path, contents := range map[string]string{
		"go.mod":               "module example.test/package\n\ngo 1.26\n",
		"client.go":            "package packageexample\n",
		"nested/source.go":     "package nested\n",
		"generated/output.go":  "package generated\n",
		".env":                 "CEKAT_ACCESS_TOKEN=test-secret-token\n",
		"credentials.txt":      "test-secret-token\n",
		".netrc":               "machine api.example.test login user password test-secret-token\n",
		".npmrc":               "//registry.example.test/:_authToken=test-secret-token\n",
		".pypirc":              "[pypi]\nusername = user\npassword = test-secret-token\n",
		"id_rsa":               "test-secret-token\n",
		"private.pem":          "test-secret-token\n",
		"private.key":          "test-secret-token\n",
		"service-account.json": "{\"private_key\":\"test-secret-token\"}\n",
		"auth.json":            "{\"token\":\"test-secret-token\"}\n",
		"README.md":            "# test package\n",
	} {
		fullPath := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
			t.Fatalf("make directory: %v", err)
		}
		if err := os.WriteFile(fullPath, []byte(contents), 0o644); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}
	git(t, root, "init", "-q")
	git(t, root, "add", ".")
	return root
}

func git(t *testing.T, directory string, args ...string) {
	t.Helper()
	command := append([]string{"-C", directory}, args...)
	if output, err := runGit(command...); err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, output)
	}
}
