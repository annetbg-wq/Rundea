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
	mode     int64
	linkname string
}

func sourceArchive(t *testing.T, entries []archiveEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
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
		hdr := &tar.Header{
			Name: entry.name,
			Mode: mode,
			Size: int64(len(entry.body)),
			Typeflag: typeflag,
			Linkname: entry.linkname,
		}
		if typeflag == tar.TypeDir || typeflag == tar.TypeSymlink || typeflag == tar.TypeLink {
			hdr.Size = 0
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if hdr.Size > 0 {
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
	return buf.Bytes()
}

func TestExtractSourceArchiveStripsGitHubRoot(t *testing.T) {
	destination := filepath.Join(t.TempDir(), "src")
	archive := sourceArchive(t, []archiveEntry{
		{name: "owner-repo-sha/", typeflag: tar.TypeDir},
		{name: "owner-repo-sha/package.json", body: `{"scripts":{"start":"node index.js"}}`},
		{name: "owner-repo-sha/bin/start.sh", body: "#!/bin/sh\necho ok\n", mode: 0o755},
	})
	if err := extractSourceArchive(bytes.NewReader(archive), destination); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(destination, "package.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"start"`) {
		t.Fatalf("unexpected package.json: %s", body)
	}
	info, err := os.Stat(filepath.Join(destination, "bin", "start.sh"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o111 == 0 {
		t.Fatal("expected executable bit to be retained")
	}
}

func TestExtractSourceArchiveRejectsTraversal(t *testing.T) {
	destination := filepath.Join(t.TempDir(), "src")
	archive := sourceArchive(t, []archiveEntry{
		{name: "root/", typeflag: tar.TypeDir},
		{name: "root/../../escape.txt", body: "nope"},
	})
	if err := extractSourceArchive(bytes.NewReader(archive), destination); err == nil {
		t.Fatal("expected traversal archive to be rejected")
	}
}

func TestExtractSourceArchiveRejectsLinks(t *testing.T) {
	destination := filepath.Join(t.TempDir(), "src")
	archive := sourceArchive(t, []archiveEntry{
		{name: "root/", typeflag: tar.TypeDir},
		{name: "root/target.txt", body: "target"},
		{name: "root/link", typeflag: tar.TypeSymlink, linkname: "target.txt"},
	})
	if err := extractSourceArchive(bytes.NewReader(archive), destination); err == nil {
		t.Fatal("expected symlink archive to be rejected")
	}
}

func TestSourceBundleURLDoesNotPutTicketInURL(t *testing.T) {
	got, err := sourceBundleURL("https://control.example/base", "deployment-id")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://control.example/base/v0/source-bundles/deployment-id" {
		t.Fatalf("unexpected source bundle URL: %s", got)
	}
}
