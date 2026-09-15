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
	modulePath     = "go.cekat.ai/event-sdk"
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
	manifest := packageManifest{SchemaVersion: 1, Language: "go", Version: version}
	for _, module := range publishableModules(files) {
		archiveName := fmt.Sprintf("%s-v%s.zip", module.archiveStem(), version)
		archivePath := filepath.Join(output, archiveName)
		if err := writeArchive(archivePath, moduleRoot, module, version); err != nil {
			return err
		}
		contents, err := os.ReadFile(archivePath)
		if err != nil {
			return fmt.Errorf("read completed archive: %w", err)
		}
		digest := sha256.Sum256(contents)
		manifest.Artifacts = append(manifest.Artifacts, manifestArtifact{
			Path:      archiveName,
			SHA256:    hex.EncodeToString(digest[:]),
			SizeBytes: int64(len(contents)),
		})
	}
	sort.Slice(manifest.Artifacts, func(i, j int) bool { return manifest.Artifacts[i].Path < manifest.Artifacts[j].Path })
	encoded, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("encode manifest: %w", err)
	}
	if err := os.WriteFile(filepath.Join(output, "manifest.json"), append(encoded, '\n'), 0o644); err != nil {
		return fmt.Errorf("write manifest: %w", err)
	}
	return nil
}

// moduleSource is one Go module inside the repository and the tracked files it owns.
type moduleSource struct {
	dir   string // slash-separated directory relative to the root module; "" for the root
	files []string
}

func (m moduleSource) path() string {
	if m.dir == "" {
		return modulePath
	}
	return modulePath + "/" + m.dir
}

func (m moduleSource) archiveStem() string {
	if m.dir == "" {
		return "cekat-event-sdk-go"
	}
	return "cekat-event-sdk-go-" + strings.ReplaceAll(m.dir, "/", "-")
}

// publishableModules assigns each tracked file to its innermost Go module, as
// Go module zips do, and omits modules under internal/, which are never published.
func publishableModules(files []string) []moduleSource {
	dirs := []string{""}
	for _, file := range files {
		if dir, name := splitSlashPath(file); name == "go.mod" && dir != "" {
			dirs = append(dirs, dir)
		}
	}
	owned := make(map[string][]string, len(dirs))
	for _, file := range files {
		owner := ""
		for _, dir := range dirs {
			if dir != "" && strings.HasPrefix(file, dir+"/") && len(dir) > len(owner) {
				owner = dir
			}
		}
		owned[owner] = append(owned[owner], strings.TrimPrefix(file, owner+"/"))
	}
	modules := make([]moduleSource, 0, len(dirs))
	for _, dir := range dirs {
		if dir == "internal" || strings.HasPrefix(dir, "internal/") || len(owned[dir]) == 0 {
			continue
		}
		modules = append(modules, moduleSource{dir: dir, files: owned[dir]})
	}
	sort.Slice(modules, func(i, j int) bool { return modules[i].dir < modules[j].dir })
	return modules
}

func splitSlashPath(file string) (dir, name string) {
	index := strings.LastIndex(file, "/")
	if index < 0 {
		return "", file
	}
	return file[:index], file[index+1:]
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
	if file == "README.md" || file == "COMPATIBILITY.md" || file == "scripts/package" || file == "scripts/conformance" {
		return true
	}
	if _, name := splitSlashPath(file); name == "go.mod" || name == "go.sum" {
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

func writeArchive(archivePath, repositoryRoot string, module moduleSource, version string) error {
	archive, err := os.OpenFile(archivePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return fmt.Errorf("create archive: %w", err)
	}
	writer := zip.NewWriter(archive)
	root := module.path() + "@v" + version + "/"
	moduleRoot := filepath.Join(repositoryRoot, filepath.FromSlash(module.dir))
	for _, file := range module.files {
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
