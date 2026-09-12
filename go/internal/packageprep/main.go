// Command packageprep creates the deterministic, local release-preparation archive.
package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	packageVersion = "0.1.0"
	modulePath     = "github.com/cekataiofficial/cekat-event-sdk-go"
)

type packageManifest struct {
	SchemaVersion int                `json:"schema_version"`
	Language      string             `json:"language"`
	Version       string             `json:"version"`
	Artifacts     []manifestArtifact `json:"artifacts"`
}

type manifestArtifact struct {
	Path      string `json:"path"`
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"size_bytes"`
}

func main() {
	if len(os.Args) != 5 || os.Args[1] != "--version" || os.Args[3] != "--output" {
		fail(errors.New("usage: packageprep --version 0.1.0 --output <absolute-directory>"))
	}
	root, err := os.Getwd()
	if err != nil {
		fail(fmt.Errorf("resolve module root: %w", err))
	}
	if err := prepare(os.Args[2], os.Args[4], root); err != nil {
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "packageprep:", err)
	os.Exit(2)
}

func prepare(version, output, moduleRoot string) error {
	if version != packageVersion {
		return fmt.Errorf("version must be exactly %s", packageVersion)
	}
	if err := validateOutput(output); err != nil {
		return err
	}
	files, err := trackedSourceFiles(moduleRoot)
	if err != nil {
		return err
	}
	archiveName := fmt.Sprintf("cekat-event-sdk-go-v%s.zip", version)
	archivePath := filepath.Join(output, archiveName)
	if err := writeArchive(archivePath, moduleRoot, version, files); err != nil {
		return err
	}
	contents, err := os.ReadFile(archivePath)
	if err != nil {
		return fmt.Errorf("read completed archive: %w", err)
	}
	digest := sha256.Sum256(contents)
	manifest := packageManifest{
		SchemaVersion: 1,
		Language:      "go",
		Version:       version,
		Artifacts: []manifestArtifact{{
			Path:      archiveName,
			SHA256:    hex.EncodeToString(digest[:]),
			SizeBytes: int64(len(contents)),
		}},
	}
	encoded, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("encode manifest: %w", err)
	}
	if err := os.WriteFile(filepath.Join(output, "manifest.json"), append(encoded, '\n'), 0o644); err != nil {
		return fmt.Errorf("write manifest: %w", err)
	}
	return nil
}

func validateOutput(output string) error {
	if !filepath.IsAbs(output) || filepath.Clean(output) != output {
		return errors.New("output must be a clean absolute directory path")
	}
	info, err := os.Lstat(output)
	if err != nil {
		return fmt.Errorf("inspect output: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("output must be a non-symlink directory")
	}
	entries, err := os.ReadDir(output)
	if err != nil {
		return fmt.Errorf("read output directory: %w", err)
	}
	if len(entries) != 0 {
		return errors.New("output directory must be empty")
	}
	return nil
}

func trackedSourceFiles(moduleRoot string) ([]string, error) {
	output, err := runGit("-C", moduleRoot, "ls-files", "-z")
	if err != nil {
		return nil, fmt.Errorf("list Git-tracked module files: %w: %s", err, strings.TrimSpace(output))
	}
	var files []string
	for _, file := range strings.Split(strings.TrimSuffix(output, "\x00"), "\x00") {
		if file == "" || excludedSourcePath(file) || !allowedSourcePath(file) {
			continue
		}
		if filepath.IsAbs(file) || strings.Contains(file, "\\") || !safeRelativePath(file) {
			return nil, fmt.Errorf("unsafe tracked path %q", file)
		}
		info, err := os.Lstat(filepath.Join(moduleRoot, filepath.FromSlash(file)))
		if err != nil {
			return nil, fmt.Errorf("inspect tracked file %q: %w", file, err)
		}
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("tracked source %q is not a regular file", file)
		}
		files = append(files, file)
	}
	if len(files) == 0 {
		return nil, errors.New("no eligible Git-tracked source files")
	}
	sort.Strings(files)
	return files, nil
}

func runGit(args ...string) (string, error) {
	command := exec.Command("git", args...)
	output, err := command.CombinedOutput()
	return string(output), err
}

func excludedSourcePath(file string) bool {
	parts := strings.Split(file, "/")
	for _, part := range parts {
		lower := strings.ToLower(part)
		if part == ".git" || part == "generated" || part == "dist" || part == "build" || part == "coverage" ||
			part == ".env" || strings.HasPrefix(part, ".env.") || credentialSourceName(lower) ||
			strings.Contains(lower, "credential") || strings.Contains(lower, "secret") ||
			strings.Contains(lower, "token") {
			return true
		}
	}
	return false
}

// allowedSourcePath admits only source, module metadata, documentation, and the
// two tracked local wrappers. New artifact file types must be deliberately added.
func allowedSourcePath(file string) bool {
	if file == "go.mod" || file == "go.sum" || file == "README.md" || file == "COMPATIBILITY.md" ||
		file == "scripts/package" || file == "scripts/conformance" {
		return true
	}
	return strings.HasSuffix(file, ".go")
}

func credentialSourceName(name string) bool {
	if name == ".netrc" || name == ".npmrc" || name == ".pypirc" || name == "id_rsa" ||
		name == "id_dsa" || name == "id_ecdsa" || name == "id_ed25519" ||
		name == "authorized_keys" || name == "known_hosts" || name == "auth.json" ||
		name == "service-account.json" || name == "service_account.json" ||
		name == "credentials.json" {
		return true
	}
	return strings.HasSuffix(name, ".pem") || strings.HasSuffix(name, ".key") ||
		strings.HasSuffix(name, ".p12") || strings.HasSuffix(name, ".pfx") ||
		strings.HasSuffix(name, ".jks") || strings.HasSuffix(name, ".keystore")
}

func safeRelativePath(path string) bool {
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

func writeArchive(archivePath, moduleRoot, version string, files []string) error {
	archive, err := os.OpenFile(archivePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return fmt.Errorf("create archive: %w", err)
	}
	writer := zip.NewWriter(archive)
	root := modulePath + "@v" + version + "/"
	for _, file := range files {
		if err := addArchiveFile(writer, root+file, filepath.Join(moduleRoot, filepath.FromSlash(file))); err != nil {
			writer.Close()
			archive.Close()
			return err
		}
	}
	if err := writer.Close(); err != nil {
		archive.Close()
		return fmt.Errorf("finish archive: %w", err)
	}
	if err := archive.Close(); err != nil {
		return fmt.Errorf("close archive: %w", err)
	}
	return nil
}

func addArchiveFile(writer *zip.Writer, archivePath, sourcePath string) error {
	source, err := os.Open(sourcePath)
	if err != nil {
		return fmt.Errorf("open source %q: %w", sourcePath, err)
	}
	defer source.Close()
	header := &zip.FileHeader{
		Name:     archivePath,
		Method:   zip.Deflate,
		Modified: time.Date(1980, time.January, 1, 0, 0, 0, 0, time.UTC),
	}
	header.SetMode(0o644)
	destination, err := writer.CreateHeader(header)
	if err != nil {
		return fmt.Errorf("create archive entry %q: %w", archivePath, err)
	}
	if _, err := io.Copy(destination, source); err != nil {
		return fmt.Errorf("write archive entry %q: %w", archivePath, err)
	}
	return nil
}
