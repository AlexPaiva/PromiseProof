// Assembles the combined public site into dist/site:
//   /              -> landing/index.html   (the front door)
//   /walkthrough/  -> the judge walkthrough, built with a /walkthrough/ base
//   /verify/       -> the hosted deterministic verifier, built with a /verify/ base
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
const VF = "dist/_verify";

// 1) Build each sub-path page with the base its sub-path needs, so asset URLs
//    resolve under the sub-path. The walkthrough reads PP_WALKTHROUGH_BASE from
//    vite.config.ts; the verifier passes --base, which overrides the default "/".
console.log("• building walkthrough (base=/walkthrough/) ...");
execSync(`npx vite build --outDir ${WT} --emptyOutDir`, {
  stdio: "inherit",
  env: { ...process.env, PP_WALKTHROUGH_BASE: "/walkthrough/" },
});

console.log("• building verifier (base=/verify/) ...");
execSync(`npx vite build --base=/verify/ --outDir ${VF} --emptyOutDir`, {
  stdio: "inherit",
});

// 2) Fresh output tree.
rmSync(SITE, { recursive: true, force: true });
mkdirSync(`${SITE}/walkthrough/assets`, { recursive: true });
mkdirSync(`${SITE}/verify/assets`, { recursive: true });

// 3) Landing at the root (already carries relative /walkthrough/ and /verify/ CTAs).
copyFileSync("landing/index.html", `${SITE}/index.html`);

// 4) Shared static assets. Root serves the landing's; the sub-pages reference
//    /walkthrough/favicon.* and /verify/favicon.* (Vite rewrote those under each base).
const shared = ["favicon.svg", "favicon.ico", "apple-touch-icon.png", "og-card.png"];
for (const f of shared) copyFileSync(`public/${f}`, `${SITE}/${f}`);
for (const sub of ["walkthrough", "verify"]) {
  for (const f of ["favicon.svg", "favicon.ico", "apple-touch-icon.png"]) {
    copyFileSync(`public/${f}`, `${SITE}/${sub}/${f}`);
  }
}

// 5) Each sub-page + only the assets it actually references.
function assemble(intermediateDir, htmlName, sub) {
  copyFileSync(`${intermediateDir}/${htmlName}`, `${SITE}/${sub}/index.html`);
  const html = readFileSync(`${SITE}/${sub}/index.html`, "utf8");
  const pattern = new RegExp(`/${sub}/assets/([^"?#]+)`, "g");
  const assets = [...html.matchAll(pattern)].map((m) => m[1]);
  for (const a of new Set(assets)) {
    copyFileSync(`${intermediateDir}/assets/${a}`, `${SITE}/${sub}/assets/${a}`);
  }
  return new Set(assets).size;
}

const wtCount = assemble(WT, "judge.html", "walkthrough");
const vfCount = assemble(VF, "verify.html", "verify");

// 6) Drop the intermediate builds.
rmSync(WT, { recursive: true, force: true });
rmSync(VF, { recursive: true, force: true });

console.log(
  `✓ built ${SITE} (landing + /walkthrough/ [${wtCount} assets] + /verify/ [${vfCount} assets])`,
);
