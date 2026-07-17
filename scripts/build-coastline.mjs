import { writeFile } from "node:fs/promises";
import { mesh } from "topojson-client";
import land from "world-atlas/land-50m.json" with { type: "json" };

const coastline = mesh(land, land.objects.land);
const lines = [];

function isArtificialEdge(a, b) {
  const crossesAntimeridian = Math.abs(a[0] - b[0]) > 180;
  const followsAntimeridian = Math.abs(a[0]) >= 179.999 && Math.abs(b[0]) >= 179.999;
  const closesAtPole = Math.abs(a[1]) >= 89.999 && Math.abs(b[1]) >= 89.999;
  return crossesAntimeridian || followsAntimeridian || closesAtPole;
}

for (const sourceLine of coastline.coordinates) {
  let line = [];
  for (let index = 1; index < sourceLine.length; index += 1) {
    const a = sourceLine[index - 1];
    const b = sourceLine[index];
    if (isArtificialEdge(a, b)) {
      if (line.length > 1) lines.push(line);
      line = [];
      continue;
    }
    if (line.length === 0) line.push(a);
    line.push(b);
  }
  if (line.length > 1) lines.push(line);
}

const geojson = {
  type: "Feature",
  properties: { source: "Natural Earth land, coastline only" },
  geometry: { type: "MultiLineString", coordinates: lines },
};

await writeFile(new URL("../public/coastline.geojson", import.meta.url), JSON.stringify(geojson));
