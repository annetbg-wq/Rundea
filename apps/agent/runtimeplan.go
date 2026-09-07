package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

type railwayConfig struct {
	Deploy struct {
		HealthcheckPath string `json:"healthcheckPath"`
	} `json:"deploy"`
}

func resolveHealthcheckPath(sourceDir, requested string) string {
	if strings.TrimSpace(requested) != "" {
		return normalizeHealthPath(requested)
	}
	contents, err := os.ReadFile(filepath.Join(sourceDir, "railway.json"))
	if err == nil {
		var config railwayConfig
		if json.Unmarshal(contents, &config) == nil && strings.TrimSpace(config.Deploy.HealthcheckPath) != "" {
			return normalizeHealthPath(config.Deploy.HealthcheckPath)
		}
	}
	return "/health"
}

func normalizeHealthPath(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "/health"
	}
	if !strings.HasPrefix(value, "/") {
		return "/" + value
	}
	return value
}
