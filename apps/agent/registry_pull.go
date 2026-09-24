package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type registryPullCredentials struct {
	Server   string `json:"server"`
	Username string `json:"username"`
	Password string `json:"password"`
}

func registryHostFromImageRef(imageRef string) (string, error) {
	value := strings.TrimSpace(imageRef)
	marker := strings.LastIndex(value, "@")
	if marker >= 0 {
		value = value[:marker]
	}
	slash := strings.Index(value, "/")
	if slash <= 0 {
		return "", errors.New("registry image reference has no explicit registry host")
	}
	host := strings.ToLower(value[:slash])
	if host == "" || len(host) > 255 || strings.ContainsAny(host, " \t\r\n/@") {
		return "", errors.New("registry image reference has invalid registry host")
	}
	return host, nil
}

func registryPullCredentialURL(base, deploymentID string) (string, error) {
	u, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || deploymentID == "" {
		return "", errors.New("invalid registry pull credential endpoint")
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/v0/registry-pull-credentials/" + url.PathEscape(deploymentID)
	u.RawQuery = ""
	u.Fragment = ""
	return u.String(), nil
}

func fetchRegistryPullCredentials(
	ctx context.Context,
	cfg config,
	deploymentID, ticket, imageRef string,
) (*registryPullCredentials, error) {
	if strings.TrimSpace(ticket) == "" {
		return nil, nil
	}
	endpoint, err := registryPullCredentialURL(cfg.ControlPlane, deploymentID)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+ticket)
	req.Header.Set("X-Rundea-Node-Id", cfg.NodeID)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("registry pull credential request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("registry pull credential request returned %s", resp.Status)
	}
	var credentials registryPullCredentials
	if err := json.NewDecoder(io.LimitReader(resp.Body, 16*1024)).Decode(&credentials); err != nil {
		return nil, fmt.Errorf("registry pull credential response: %w", err)
	}
	expectedHost, err := registryHostFromImageRef(imageRef)
	if err != nil {
		return nil, err
	}
	if strings.ToLower(strings.TrimSpace(credentials.Server)) != expectedHost {
		return nil, errors.New("registry pull credential server does not match immutable image host")
	}
	if credentials.Username == "" || credentials.Password == "" || strings.ContainsAny(credentials.Username, "\r\n\x00") || strings.ContainsAny(credentials.Password, "\r\n\x00") {
		return nil, errors.New("registry pull credential response is invalid")
	}
	return &credentials, nil
}
