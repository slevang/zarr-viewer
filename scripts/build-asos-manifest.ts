import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  asyncBufferFromUrl,
  parquetMetadataAsync,
  parquetRead,
  type ColumnData,
} from "hyparquet";
import { compressors } from "hyparquet-compressors";

const ASOS_BASE_URL = [
  "https://s3.us-west-2.amazonaws.com",
  "us-west-2.opendata.source.coop",
  "dynamical/asos-parquet",
].join("/");
const year = Number(process.argv[2] ?? new Date().getUTCFullYear());
const outputPath = resolve(
  process.argv[3] ?? "public/asos-stations.geojson",
);
const parquetUrl = `${ASOS_BASE_URL}/year%3D${year}/data.parquet`;
const columns = [
  "station",
  "longitude",
  "latitude",
  "name",
  "state",
  "country",
  "elevation",
];

async function byteLength(url: string) {
  const response = await retryingFetch(url, {
    headers: { Range: "bytes=0-0" },
  });
  if (!response.ok) {
    throw new Error(`ASOS size request failed (${response.status})`);
  }
  const match = response.headers.get("content-range")?.match(/\/(\d+)$/);
  if (!match) throw new Error("ASOS response did not include Content-Range");
  return Number(match[1]);
}

async function retryingFetch(
  input: string | URL | Request,
  init?: RequestInit,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(input, init);
      if (response.ok || response.status < 500) return response;
      await response.body?.cancel();
      lastError = new Error(`ASOS request failed (${response.status})`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
  }
  throw lastError;
}

function valueAt(chunk: ColumnData | undefined, row: number) {
  if (!chunk || row < chunk.rowStart || row >= chunk.rowEnd) return undefined;
  return chunk.columnData[row - chunk.rowStart];
}

const file = await asyncBufferFromUrl({
  url: parquetUrl,
  byteLength: await byteLength(parquetUrl),
  fetch: retryingFetch,
});
const metadata = await parquetMetadataAsync(file);
const stations = new Map<string, Record<string, unknown>>();
let rowStart = 0;

for (const [groupIndex, group] of metadata.row_groups.entries()) {
  const rowEnd = rowStart + Number(group.num_rows);
  const chunks = new Map<string, ColumnData>();
  await parquetRead({
    file,
    metadata,
    compressors,
    columns,
    rowStart,
    rowEnd,
    onChunk: (chunk) => chunks.set(chunk.columnName, chunk),
  });

  const stationChunk = chunks.get("station");
  if (!stationChunk) throw new Error(`Row group ${groupIndex} has no station column`);
  let previousStation = "";
  for (let row = rowStart; row < rowEnd; row += 1) {
    const station = String(valueAt(stationChunk, row) ?? "");
    if (!station || station === previousStation || stations.has(station)) continue;
    previousStation = station;
    const longitude = Number(valueAt(chunks.get("longitude"), row));
    const latitude = Number(valueAt(chunks.get("latitude"), row));
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
    stations.set(station, {
      station,
      name: String(valueAt(chunks.get("name"), row) ?? station),
      state: String(valueAt(chunks.get("state"), row) ?? ""),
      country: String(valueAt(chunks.get("country"), row) ?? ""),
      elevation: Number(valueAt(chunks.get("elevation"), row)),
      longitude,
      latitude,
    });
  }
  rowStart = rowEnd;
  console.log(
    `ASOS manifest: ${groupIndex + 1}/${metadata.row_groups.length} row groups, `
    + `${stations.size} stations`,
  );
}

const features = [...stations.values()]
  .sort((a, b) => String(a.station).localeCompare(String(b.station)))
  .map(({ longitude, latitude, ...properties }) => ({
    type: "Feature" as const,
    id: properties.station,
    geometry: {
      type: "Point" as const,
      coordinates: [longitude, latitude],
    },
    properties,
  }));
const collection = {
  type: "FeatureCollection" as const,
  metadata: {
    source: parquetUrl,
    year,
    generatedAt: new Date().toISOString(),
  },
  features,
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(collection));
console.log(`Wrote ${features.length} stations to ${outputPath}`);
