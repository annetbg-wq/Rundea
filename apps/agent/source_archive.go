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
	"strings"
	"time"
)

const (
	maxCompressedSourceBytes   int64 = 64 * 1024 * 1024
	maxUncompressedSourceBytes int64 = 512 * 1024 * 1024
	maxSourceArchiveEntries          = 100000
)

func materializeSource(ctx context.Context, cfg config, w *writer, cmd deployCommand, destination string) (string, error) {
	handled, sourceSHA, err := tryBrokeredSource(ctx, cfg, cmd.DeploymentID, cmd.Source.Ref, destination)
	if err != nil {
		return "", err
	}
	if handled {
		w.log(cmd.DeploymentID, "system", "source delivered through Rundea private-source broker")
		return sourceSHA, nil
	}
	if err := cloneSource(ctx, w, cmd.DeploymentID, cmd.Source.Repository, cmd.Source.Ref, destination); err != nil {
		return "", err
	}
	return sourceCommitSHA(ctx, destination)
}

func sourceArchiveURL(controlPlane, deploymentID string) (string, error) {
	u, err := url.Parse(controlPlane)
	if err != nil {
		return "", err
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("unsupported control plane scheme %q", u.Scheme)
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/v0/deployments/" + url.PathEscape(deploymentID) + "/source-archive"
	u.RawQuery = ""
	u.Fragment = ""
	return u.String(), nil
}

func tryBrokeredSource(ctx context.Context, cfg config, deploymentID, sourceRef, destination string) (bool, string, error) {
	endpoint, err := sourceArchiveURL(cfg.ControlPlane, deploymentID)
	if err != nil {
		return false, "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return false, "", err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("X-Rundea-Node-Id", cfg.NodeID)
	client := &http.Client{Timeout: 2 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return false, "", fmt.Errorf("private source broker request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return false, "", nil
	}
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return true, "", fmt.Errorf("private source broker returned HTTP %d", resp.StatusCode)
	}
	if !isFullGitCommit(sourceRef) {
		return true, "", errors.New("brokered private source requires an exact commit SHA")
	}
	expectedSHA := strings.ToLower(sourceRef)
	if actual := strings.ToLower(resp.Header.Get("X-Rundea-Source-Sha")); actual != expectedSHA {
		return true, "", fmt.Errorf("private source identity mismatch: expected %s, received %s", expectedSHA, actual)
	}
	if declared := resp.ContentLength; declared > maxCompressedSourceBytes {
		return true, "", errors.New("compressed private source exceeds 64 MiB")
	}
	limited := &io.LimitedReader{R: resp.Body, N: maxCompressedSourceBytes + 1}
	if err := extractSourceArchive(limited, destination); err != nil {
		return true, "", err
	}
	if limited.N <= 0 {
		return true, "", errors.New("compressed private source exceeds 64 MiB")
	}
	return true, expectedSHA, nil
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
