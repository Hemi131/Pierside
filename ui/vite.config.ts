import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Rancher serves the UI from x-rd-extension://<id>/ui/dashboard-tab/, so assets must be relative.
  base: "./",
  build: { outDir: "build", chunkSizeWarningLimit: 2000 },
  server: { port: 3000, strictPort: true },
});
