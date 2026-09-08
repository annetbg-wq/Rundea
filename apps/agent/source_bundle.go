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
	maxSourceBundleCompressedBytes   int64 = 64 * 1024 * 1024
	maxSourceBundleUncompressedBytes int64 = 256 * 1024 * 1024
	maxSourceBundleFileBytes         int64 = 64 * 1024 * 1024
	maxSourceBundleEntries                 = 20000
)

func sourceBundleURL(base, deploymentID string) (string, error) {
	u, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("unsupported control plane scheme %q", u.Scheme)
	}
	if u.Host == "" || deploymentID == "" {
		return "", errors.New("invalid source bundle endpoint")
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/v0/source-bundles/" + url.PathEscape(deploymentID)
	u.RawQuery = ""
	u.Fragment = ""
	return u.String(), nil
}

func fetchBrokeredSource(ctx context.Context, cfg config, deploymentID, ticket, expectedSHA, destination string) error {
	if ticket == "" || !isFullGitCommit(expectedSHA) {
		return errors.New("brokered source command is missing ticket or exact source SHA")
	}
	endpoint, err := sourceBundleURL(cfg.ControlPlane, deploymentID)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+ticket)
	req.Header.Set("X-Rundea-Node-Id", cfg.NodeID)
	client := &http.Client{Timeout: 2 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("source bundle request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("source bundle request returned %s", resp.Status)
	}
	if declared := resp.ContentLength; declared > maxSourceBundleCompressedBytes {
		return errors.New("source bundle exceeds compressed size limit")
	}
	resolvedSHA := strings.ToLower(strings.TrimSpace(resp.Header.Get("X-Rundea-Source-Sha")))
	if resolvedSHA != strings.ToLower(expectedSHA) {
		return fmt.Errorf("source bundle identity mismatch: expected %s, received %s", strings.ToLower(expectedSHA), resolvedSHA)
	}
	limited := &io.LimitedReader{R: resp.Body, N: maxSourceBundleCompressedBytes + 1}
	if err := extractSourceArchive(limited, destination); err != nil {
		return err
	}
	if limited.N <= 0 {
		return errors.New("source bundle exceeds compressed size limit")
	}
	return nil
}

func extractSourceArchive(compressed io.Reader, destination string) error {
	gz, err := gzip.NewReader(compressed)
	if err != nil {
		return fmt.Errorf("source bundle gzip: %w", err)
	}
	defer gz.Close()

	if err := os.RemoveAll(destination); err != nil {
		return err
	}
	if err := os.MkdirAll(destination, 0o700); err != nil {
		return err
	}
	rootAbs, err := filepath.Abs(destination)
	if err != nil {
		return err
	}

	tr := tar.NewReader(gz)
	var archiveRoot string
	var totalBytes int64
	entries := 0
	files := 0
	seen := map[string]struct{}{}

	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("source bundle tar: %w", err)
		}
		entries++
		if entries > maxSourceBundleEntries {
			return errors.New("source bundle contains too many entries")
		}
		if strings.ContainsRune(hdr.Name, '\x00') || strings.ContainsRune(hdr.Name, '\\') {
			return errors.New("source bundle contains an unsafe path")
		}
		clean := path.Clean(strings.TrimPrefix(hdr.Name, "./"))
		if clean == "." || clean == "" {
			continue
		}
		if path.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") {
			return errors.New("source bundle path escapes archive root")
		}
		parts := strings.Split(clean, "/")
		if len(parts) == 0 || parts[0] == "" || parts[0] == "." || parts[0] == ".." {
			return errors.New("source bundle has an invalid archive root")
		}
		if archiveRoot == "" {
			archiveRoot = parts[0]
		} else if archiveRoot != parts[0] {
			return errors.New("source bundle contains multiple archive roots")
		}
		if len(parts) == 1 {
			switch hdr.Typeflag {
			case tar.TypeDir:
				continue
			case tar.TypeReg, tar.TypeRegA:
				if hdr.Size == 0 {
					continue
				}
			}
			return fmt.Errorf("source bundle root marker rejected: type=%d size=%d mode=%o", hdr.Typeflag, hdr.Size, hdr.Mode)
		}

		relSlash := strings.Join(parts[1:], "/")
		if _, ok := seen[relSlash]; ok {
			return fmt.Errorf("source bundle contains duplicate path %q", relSlash)
		}
		seen[relSlash] = struct{}{}
		target := filepath.Join(rootAbs, filepath.FromSlash(relSlash))
		targetAbs, err := filepath.Abs(target)
		if err != nil {
			return err
		}
		relCheck, err := filepath.Rel(rootAbs, targetAbs)
		if err != nil || relCheck == ".." || strings.HasPrefix(relCheck, ".."+string(filepath.Separator)) {
			return errors.New("source bundle target escapes destination")
		}

		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(targetAbs, 0o755); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			if hdr.Size < 0 || hdr.Size > maxSourceBundleFileBytes {
				return fmt.Errorf("source bundle file %q exceeds per-file limit", relSlash)
			}
			totalBytes += hdr.Size
			if totalBytes > maxSourceBundleUncompressedBytes {
				return errors.New("source bundle exceeds uncompressed size limit")
			}
			if err := os.MkdirAll(filepath.Dir(targetAbs), 0o755); err != nil {
				return err
			}
			mode := os.FileMode(0o644)
			if hdr.Mode&0o111 != 0 {
				mode = 0o755
			}
			file, err := os.OpenFile(targetAbs, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
			if err != nil {
				return err
			}
			written, copyErr := io.CopyN(file, tr, hdr.Size)
			closeErr := file.Close()
			if copyErr != nil || written != hdr.Size {
				return fmt.Errorf("source bundle file %q was truncated", relSlash)
			}
			if closeErr != nil {
				return closeErr
			}
			files++
		case tar.TypeSymlink, tar.TypeLink:
			return fmt.Errorf("source bundle links are unsupported in v0: %q", relSlash)
		default:
			return fmt.Errorf("source bundle contains unsupported entry type for %q", relSlash)
		}
	}
	if archiveRoot == "" || files == 0 {
		return errors.New("source bundle contains no source files")
	}
	return nil
}
