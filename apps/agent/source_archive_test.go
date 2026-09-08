package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type archiveEntry struct {
	name     string
	body     string
	typeflag byte
	linkname string
	mode     int64
}

func sourceArchive(t *testing.T, entries []archiveEntry) []byte {
	t.Helper()
	var buffer bytes.Buffer
	gz := gzip.NewWriter(&buffer)
	tw := tar.NewWriter(gz)
	for _, entry := range entries {
		typeflag := entry.typeflag
		if typeflag == 0 {
			typeflag = tar.TypeReg
		}
		mode := entry.mode
		if mode == 0 {
			mode = 0o644
		}
		header := &tar.Header{Name: entry.name, Mode: mode, Typeflag: typeflag, Linkname: entry.linkname}
		if typeflag == tar.TypeReg || typeflag == tar.TypeRegA {
			header.Size = int64(len(entry.body))
		}
		if err := tw.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if header.Size > 0 {
			if _, err := tw.Write([]byte(entry.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestExtractSourceArchive(t *testing.T) {
	destination := t.TempDir()
	archive := sourceArchive(t, []archiveEntry{
		{name: "fixture-root/", typeflag: tar.TypeDir, mode: 0o755},
		{name: "fixture-root/package.json", body: `{"scripts":{"start":"node index.js"}}`},
		{name: "fixture-root/index.js", body: "console.log('ok')\n", mode: 0o755},
	})
	if err := extractSourceArchive(bytes.NewReader(archive), destination); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(destination, "package.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "node index.js") {
		t.Fatalf("unexpected package.json: %s", body)
	}
	info, err := os.Stat(filepath.Join(destination, "index.js"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("expected executable file mode, got %o", info.Mode().Perm())
	}
}

func TestExtractSourceArchiveRejectsTraversal(t *testing.T) {
	archive := sourceArchive(t, []archiveEntry{{name: "fixture-root/../../escape", body: "nope"}})
	err := extractSourceArchive(bytes.NewReader(archive), t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "escapes") {
		t.Fatalf("expected traversal rejection, got %v", err)
	}
}

func TestExtractSourceArchiveRejectsLinks(t *testing.T) {
	archive := sourceArchive(t, []archiveEntry{
		{name: "fixture-root/file", body: "safe"},
		{name: "fixture-root/link", typeflag: tar.TypeSymlink, linkname: "file"},
	})
	err := extractSourceArchive(bytes.NewReader(archive), t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "links are unsupported") {
		t.Fatalf("expected symlink rejection, got %v", err)
	}
}

func TestExtractSourceArchiveRejectsMultipleRoots(t *testing.T) {
	archive := sourceArchive(t, []archiveEntry{
		{name: "root-one/a", body: "a"},
		{name: "root-two/b", body: "b"},
	})
	err := extractSourceArchive(bytes.NewReader(archive), t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "multiple roots") {
		t.Fatalf("expected multiple-root rejection, got %v", err)
	}
}

func TestSourceArchiveURLUsesControlPlaneOnly(t *testing.T) {
	got, err := sourceArchiveURL("https://control.example/base", "123e4567-e89b-12d3-a456-426614174000")
	if err != nil {
		t.Fatal(err)
	}
	want := "https://control.example/base/v0/deployments/123e4567-e89b-12d3-a456-426614174000/source-archive"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}
