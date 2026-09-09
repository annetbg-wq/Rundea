package main

func caddyDockerRunArgs(options []string, command ...string) []string {
	args := []string{"run"}
	args = append(args, options...)
	args = append(args, "--entrypoint", "caddy", caddyImage)
	args = append(args, command...)
	return args
}
