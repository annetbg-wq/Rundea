package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

type packageManifest struct {
	Scripts map[string]string `json:"scripts"`
}

func prepareDockerfile(sourceDir, requested string) (path string, plan string, err error) {
	if requested != "" {
		candidate := filepath.Join(sourceDir, requested)
		if info, statErr := os.Stat(candidate); statErr != nil || info.IsDir() {
			return "", "", fmt.Errorf("requested Dockerfile %q does not exist", requested)
		}
		return requested, "dockerfile", nil
	}

	if info, statErr := os.Stat(filepath.Join(sourceDir, "Dockerfile")); statErr == nil && !info.IsDir() {
		return "Dockerfile", "dockerfile:auto", nil
	}

	manifestBytes, readErr := os.ReadFile(filepath.Join(sourceDir, "package.json"))
	if readErr != nil {
		if errors.Is(readErr, os.ErrNotExist) {
			return "", "", errors.New("no Dockerfile or supported package.json build plan found")
		}
		return "", "", readErr
	}
	var manifest packageManifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		return "", "", fmt.Errorf("parse package.json: %w", err)
	}
	if manifest.Scripts["start"] == "" {
		return "", "", errors.New("Node.js auto build requires package.json scripts.start")
	}

	install := "npm install --no-audit --no-fund"
	if info, statErr := os.Stat(filepath.Join(sourceDir, "package-lock.json")); statErr == nil && !info.IsDir() {
		install = "npm ci --no-audit --no-fund"
	}
	build := ""
	if manifest.Scripts["build"] != "" {
		build = "RUN npm run build\n"
	}
	generated := fmt.Sprintf(`FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN %s
COPY . .
%sENV NODE_ENV=production
CMD ["npm","start"]
`, install, build)
	name := ".rundea.generated.Dockerfile"
	if err := os.WriteFile(filepath.Join(sourceDir, name), []byte(generated), 0o600); err != nil {
		return "", "", fmt.Errorf("write generated Dockerfile: %w", err)
	}
	return name, "nodejs-24:auto", nil
}
