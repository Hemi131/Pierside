import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Rancher serves the UI from x-rd-extension://<id>/ui/dashboard-tab/, so assets must be relative.
  base: "./",
  build: { outDir: "build", chunkSizeWarningLimit: 2000 },
  // No CORS: the dev UI carries the session token (VITE_PIERSIDE_TOKEN, inlined into the served modules),
  // and Vite's default would let any page on localhost read those modules.
  server: { port: 3000, strictPort: true, cors: false },
});
