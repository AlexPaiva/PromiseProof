import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

export default defineConfig({
  // The judge walkthrough ships under /walkthrough/ on the combined site. The
  // build:site script sets PP_WALKTHROUGH_BASE so asset URLs resolve there;
  // the default "/" keeps the plain `vite build` and dev server unchanged.
  base: process.env.PP_WALKTHROUGH_BASE ?? "/",
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
