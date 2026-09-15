import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 5199,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2021",
    minify: false,
  },
});
