import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(() => {
  const target = process.env.RUNDEA_API_URL ?? "http://localhost:4000";
  const token = process.env.RUNDEA_CONTROL_TOKEN;

  return {
    plugins: [react()],
    server: {
      proxy: {
        "/api": {
          target,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        },
      },
    },
  };
});
