import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";

const base = process.env.BASE_PATH || "/";
const output = new URL("../dist/", import.meta.url);
const index = await readFile(new URL("index.html", output), "utf8");
const assets = await readdir(new URL("assets/", output));
const scripts = assets.filter((name) => name.endsWith(".js"));
const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

assert.match(index, new RegExp(`(?:src|href)=["']${escapedBase}assets/`));
assert.ok(scripts.length > 0, "Static build did not emit an application script");
await access(new URL("coastline.geojson", output));
await access(new URL("asos-stations.geojson", output));
await access(new URL("google-auth.html", output));
const serviceWorker = await readFile(
  new URL("coi-serviceworker.min.js", output),
  "utf8",
);
await access(new URL(".nojekyll", output));
assert.match(
  index,
  new RegExp(`src=["']${escapedBase}coi-serviceworker\\.min\\.js["']`),
  "COOP/COEP service worker URL does not honor BASE_PATH",
);
assert.match(
  serviceWorker,
  /same-origin-allow-popups/,
  "Google auth bridge does not enable popup-compatible COOP",
);
assert.match(
  serviceWorker,
  /google-auth\.html/,
  "Static build does not preserve the non-isolated Google auth bridge",
);
assert.match(
  serviceWorker,
  /"Cross-Origin-Opener-Policy", "same-origin"/,
  "Normal pages do not enable cross-origin isolation",
);
assert.match(
  serviceWorker,
  /doReload: \(\) => \{\}/,
  "Static pages should enter cross-origin isolation only on demand",
);

const bundles = await Promise.all(scripts.map((name) => readFile(new URL(`assets/${name}`, output), "utf8")));
assert.ok(bundles.some((bundle) => bundle.includes(`${base}coastline.geojson`)), "Coastline URL does not honor BASE_PATH");
assert.ok(bundles.some((bundle) => bundle.includes(`${base}asos-stations.geojson`)), "ASOS manifest URL does not honor BASE_PATH");

console.log(`Static build verified for base path ${base}`);
