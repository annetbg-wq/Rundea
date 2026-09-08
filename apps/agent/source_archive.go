package main

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

type sourceAccess struct {
	Kind    string `json:"kind"`
	GrantID string `json:"grantId"`
	Token   string `json:"token"`
}

const (
	maxCompressedSourceBytes   int64 = 64 * 1024 * 1024
	maxUncompressedSourceBytes int64 = 512 * 1024 * 1024
	maxSourceArchiveEntries          = 100000
)

var grantIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

func materializeSource(ctx context.Context, cfg config, w *writer, cmd deployCommand, destination string) (string, error) {
	if cmd.Source.Access == nil {
		if err := cloneSource(ctx, w, cmd.DeploymentID, cmd.Source.Repository, cmd.Source.Ref, destination); err != nil {
			return "", err
		}
		return sourceCommitSHA(ctx, destination)
	}
	if cmd.Source.Access.Kind != "rundeaGrant" {
		return "", fmt.Errorf("unsupported source access kind %q", cmd.Source.Access.Kind)
	}
	if !isFullGitCommit(cmd.Source.Ref) {
		return "", errors.New("brokered private source requires an exact commit SHA")
	}
	if !grantIDPattern.MatchString(cmd.Source.Access.GrantID) || cmd.Source.Access.Token == "" || len(cmd.Source.Access.Token) > 512 {
		return "", errors.New("invalid private source grant")
	}
	if err := downloadSourceGrant(ctx, cfg, cmd.Source.Access, strings.ToLower(cmd.Source.Ref), destination); err != nil {
		return "", err
	}
	return strings.ToLower(cmd.Source.Ref), nil
}

func sourceGrantURL(controlPlane, grantID string) (string, error) {
	u, err := url.Parse(controlPlane)
	if err != nil {
		return "", err
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("unsupported control plane scheme %q", u.Scheme)
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/v0/source-grants/" + url.PathEscape(grantID) + "/archive"
	u.RawQuery = ""
	u.Fragment = ""
	return u.String(), nil
}

func downloadSourceGrant(ctx context.Context, cfg config, access *sourceAccess, expectedSHA, destination string) error {
	endpoint, err := sourceGrantURL(cfg.ControlPlane, access.GrantID)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("X-Rundea-Node-Id", cfg.NodeID)
	req.Header.Set("X-Rundea-Source-Grant", access.Token)
	client := &http.Client{Timeout: 2 * 60 * 1000000000}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("source grant download: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("source grant download returned HTTP %d", resp.StatusCode)
	}
	if actual := strings.ToLower(resp.Header.Get("X-Rundea-Source-Sha")); actual != expectedSHA {
		return fmt.Errorf("source grant identity mismatch: expected %s, received %s", expectedSHA, actual)
	}
	limited := &io.LimitedReader{R: resp.Body, N: maxCompressedSourceBytes + 1}
	if err := extractSourceArchive(limited, destination); err != nil {
		return err
	}
	if limited.N <= 0 {
		return errors.New("compressed private source exceeds 64 MiB")
	}
	return nil
}

func extractSourceArchive(compressed io.Reader, destination string) error {
	gz, err := gzip.NewReader(compressed)
	if err != nil {
		return fmt.Errorf("invalid private source gzip: %w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	var prefix string
	var total int64
	entries := 0
	files := 0

	for {
		header, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("invalid private source tar: %w", err)
		}
		entries++
		if entries > maxSourceArchiveEntries {
			return errors.New("private source archive has too many entries")
		}
		name := strings.TrimPrefix(header.Name, "./")
		parts := strings.Split(name, "/")
		if len(parts) == 0 || parts[0] == "" || parts[0] == "." || parts[0] == ".." {
			return errors.New("private source archive has an invalid root")
		}
		if prefix == "" {
			prefix = parts[0]
		} else if parts[0] != prefix {
			return errors.New("private source archive has multiple roots")
		}
		if len(parts) == 1 {
			continue
		}
		rel := path.Clean(strings.Join(parts[1:], "/"))
		if rel == "." || rel == "" {
			continue
		}
		if path.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, "../") {
			return errors.New("private source archive entry escapes source root")
		}
		target := filepath.Join(destination, filepath.FromSlash(rel))
		cleanRoot := filepath.Clean(destination) + string(filepath.Separator)
		cleanTarget := filepath.Clean(target)
		if !strings.HasPrefix(cleanTarget+string(filepath.Separator), cleanRoot) {
			return errors.New("private source archive entry escapes destination")
		}

		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(cleanTarget, 0o755); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			if header.Size < 0 || header.Size > maxUncompressedSourceBytes-total {
				return errors.New("private source archive exceeds 512 MiB uncompressed")
			}
			if err := os.MkdirAll(filepath.Dir(cleanTarget), 0o755); err != nil {
				return err
			}
			mode := os.FileMode(0o644)
			if header.FileInfo().Mode()&0o111 != 0 {
				mode = 0o755
			}
			file, err := os.OpenFile(cleanTarget, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
			if err != nil {
				return err
			}
			written, copyErr := io.CopyN(file, tr, header.Size)
			closeErr := file.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
			if written != header.Size {
				return errors.New("private source archive entry was truncated")
			}
			total += written
			files++
		case tar.TypeSymlink, tar.TypeLink:
			return errors.New("private source archive links are unsupported in v0")
		default:
			return fmt.Errorf("private source archive contains unsupported entry type %d", header.Typeflag)
		}
	}
	if files == 0 {
		return errors.New("private source archive contained no files")
	}
	return nil
}
