import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Relative base so the site works under a project Pages path
// (https://<host>/<owner>/<repo>/) on github.com, ghe.com, and GHES alike.
export default defineConfig({
  base: "./",
  plugins: [react()],
});
