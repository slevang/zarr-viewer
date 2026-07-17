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
await access(new URL(".nojekyll", output));

const bundles = await Promise.all(scripts.map((name) => readFile(new URL(`assets/${name}`, output), "utf8")));
assert.ok(bundles.some((bundle) => bundle.includes(`${base}coastline.geojson`)), "Coastline URL does not honor BASE_PATH");

console.log(`Static build verified for base path ${base}`);
