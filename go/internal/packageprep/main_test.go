package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
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
		if !strings.HasPrefix(file.Name, "github.com/cekataiofficial/cekat-event-sdk-go@v0.1.0/") {
			t.Errorf("archive path %q does not use the module-version root", file.Name)
		}
		reader, err := file.Open()
		if err != nil {
			t.Fatalf("open archive entry %q: %v", file.Name, err)
		}
		reader.Close()
		if _, err := os.Stat(filepath.Join(moduleRoot, filepath.FromSlash(strings.TrimPrefix(file.Name, "github.com/cekataiofficial/cekat-event-sdk-go@v0.1.0/")))); err != nil {
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

func TestPackageScriptIsNoPublishWrapper(t *testing.T) {
	script, err := os.ReadFile(filepath.Join(goModuleRoot(t), "scripts", "package"))
	if err != nil {
		t.Fatalf("read package script: %v", err)
	}
	contents := string(script)
	for _, required := range []string{"go test ./...", "go vet ./...", "go run ./internal/packageprep"} {
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

func TestREADMEContract(t *testing.T) {
	readme, err := os.ReadFile(filepath.Join(goModuleRoot(t), "README.md"))
	if err != nil {
		t.Fatalf("read README: %v", err)
	}
	contents := string(readme)
	for _, required := range []string{
		"github.com/cekataiofficial/cekat-event-sdk-go",
		"cekat.New(",
		"context.WithTimeout",
		"WithVisitorID",
		"middleware/nethttp",
		"middleware/gin",
		"middleware/echo",
		"middleware/fiber",
		"middleware/chi",
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

func testModule(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for path, contents := range map[string]string{
		"go.mod":              "module example.test/package\n\ngo 1.26\n",
		"client.go":           "package packageexample\n",
		"nested/source.go":    "package nested\n",
		"generated/output.go": "package generated\n",
		".env":                "CEKAT_ACCESS_TOKEN=test-secret-token\n",
		"credentials.txt":     "test-secret-token\n",
		"README.md":           "# test package\n",
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
