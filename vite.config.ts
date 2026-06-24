import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Treat .excalidrawlib files as plain JSON modules
const excalidrawlibPlugin: Plugin = {
  name: "excalidrawlib-json",
  transform(code, id) {
    if (!id.endsWith(".excalidrawlib")) return;
    return { code: `export default ${code}`, map: null };
  },
};

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react(), excalidrawlibPlugin],
  // Excalidraw ships as CommonJS; tell Vite/esbuild to pre-bundle it as ESM
  optimizeDeps: {
    include: ["@excalidraw/excalidraw"],
    // force: ensures Vite finishes pre-bundling before the dev server signals "ready"
    // (prevents the race where the WebView loads before Excalidraw's CJS→ESM bundle is ready)
    force: true,
    esbuildOptions: {
      // Excalidraw reads process.env.NODE_ENV at runtime
      define: { "process.env.NODE_ENV": JSON.stringify("development") },
    },
  },
  define: {
    // Make process.env available in the browser bundle
    "process.env.NODE_ENV": JSON.stringify(
      process.env.NODE_ENV ?? "development"
    ),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  // Env variables starting with the item of `envPrefix` will be exposed in tauri's source code through `import.meta.env`.
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // Tauri uses Chromium on Windows and WebKit on macOS and Linux
    target:
      process.env.TAURI_ENV_PLATFORM == "windows"
        ? "chrome105"
        : "safari13",
    // don't minify for debug builds
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    // produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
}));
