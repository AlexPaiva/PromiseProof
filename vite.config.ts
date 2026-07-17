import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        // The seeded Signal Shelf app and the separate judge walkthrough.
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        judge: fileURLToPath(new URL("./judge.html", import.meta.url)),
      },
    },
  },
  server: {
    strictPort: true,
  },
});
