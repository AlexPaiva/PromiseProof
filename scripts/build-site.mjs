// Assembles the combined public site into dist/site:
//   /              -> landing/index.html   (the front door)
//   /walkthrough/  -> the judge walkthrough, built with a /walkthrough/ base
//
// Deploy the result with `npx wrangler deploy` (see wrangler.toml).
//
//   node scripts/build-site.mjs      (or: npm run build:site)

import { execSync } from "node:child_process";
import {
  cpSync,
  rmSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
} from "node:fs";

const SITE = "dist/site";
const WT = "dist/_walkthrough";

// 1) Build the walkthrough with the /walkthrough/ base so its asset URLs resolve
//    under the sub-path. The env var is read by vite.config.ts.
console.log("• building walkthrough (base=/walkthrough/) ...");
execSync(`npx vite build --outDir ${WT} --emptyOutDir`, {
  stdio: "inherit",
  env: { ...process.env, PP_WALKTHROUGH_BASE: "/walkthrough/" },
});

// 2) Fresh output tree.
rmSync(SITE, { recursive: true, force: true });
mkdirSync(`${SITE}/walkthrough/assets`, { recursive: true });

// 3) Landing at the root (already carries relative /walkthrough/ CTAs).
copyFileSync("landing/index.html", `${SITE}/index.html`);

// 4) Shared static assets. Root serves the landing's; the walkthrough HTML
//    references /walkthrough/favicon.* (Vite rewrote those under the base).
const shared = ["favicon.svg", "favicon.ico", "apple-touch-icon.png", "og-card.png"];
for (const f of shared) copyFileSync(`public/${f}`, `${SITE}/${f}`);
for (const f of ["favicon.svg", "favicon.ico", "apple-touch-icon.png"]) {
  copyFileSync(`public/${f}`, `${SITE}/walkthrough/${f}`);
}

// 5) Walkthrough page + only the assets it actually references.
copyFileSync(`${WT}/judge.html`, `${SITE}/walkthrough/index.html`);
const wtHtml = readFileSync(`${SITE}/walkthrough/index.html`, "utf8");
const assets = [...wtHtml.matchAll(/\/walkthrough\/assets\/([^"?#]+)/g)].map((m) => m[1]);
for (const a of new Set(assets)) {
  copyFileSync(`${WT}/assets/${a}`, `${SITE}/walkthrough/assets/${a}`);
}

// 6) Drop the intermediate build.
rmSync(WT, { recursive: true, force: true });

console.log(`✓ built ${SITE} (landing + /walkthrough/, ${assets.length} walkthrough assets)`);
