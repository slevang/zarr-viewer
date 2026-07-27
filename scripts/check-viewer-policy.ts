import assert from "node:assert/strict";
import {
  DATASETS,
  getDataset,
  getDatasetSource,
} from "../app/catalog";
import type { AxisConfig, VariableConfig } from "../app/data/types";
import {
  initialDisplayRange,
  roundRangeToSignificant,
} from "../app/viewer/display";
import {
  playbackChunkKey,
  playbackInterval,
  playbackPrefetchProfile,
} from "../app/viewer/playback";
import {
  datasetPreloadRequests,
  runDatasetPreloads,
} from "../app/viewer/dataset-preload";
import { stationFromFeature } from "../app/viewer/stations";

const dataset = getDataset("google-arco-era5");
const timeAxis: AxisConfig = {
  id: "time",
  label: "Time",
  unit: "hours since 2020-01-01 00:00:00",
  kind: "time",
  values: [0, 6],
};
assert.equal(playbackInterval(dataset, timeAxis, 0, 1), 1_000);

const temperature: VariableConfig = {
  id: "temperature",
  label: "2 metre temperature",
  unit: "K",
  dimensions: ["time", "latitude", "longitude"],
  shape: [10, 180, 360],
  chunkShape: [2, 180, 360],
  dataType: "float32",
};
assert.equal(
  playbackChunkKey(temperature, { time: 4 }),
  "/temperature/c/2/0/0",
);
assert.deepEqual(initialDisplayRange(temperature), [230, 320]);
assert.deepEqual(
  roundRangeToSignificant([0.123456789, 9876.54321]),
  [0.123457, 9876.54],
);

const source = getDatasetSource(dataset, "map");
assert.ok(source);
const profile = playbackPrefetchProfile(source, temperature, timeAxis);
assert.ok(profile.ahead > 0);
assert.ok(profile.concurrency >= 1);
const directSource = getDatasetSource(getDataset("earthmover-era5"), "map");
assert.ok(directSource);
assert.equal(
  playbackPrefetchProfile(directSource, temperature, timeAxis).directChunkReads,
  true,
);

assert.deepEqual(
  stationFromFeature({
    geometry: { type: "Point", coordinates: [-73.78, 40.64] },
    properties: {
      station: "KJFK",
      name: "John F Kennedy International",
      state: "NY",
      country: "US",
      elevation: 4,
    },
  }),
  {
    station: "KJFK",
    name: "John F Kennedy International",
    state: "NY",
    country: "US",
    elevation: 4,
    longitude: -73.78,
    latitude: 40.64,
  },
);
assert.equal(
  stationFromFeature({
    geometry: { type: "LineString", coordinates: [] },
    properties: { station: "invalid" },
  }),
  null,
);

const preloadTargetDate = new Date("2026-07-20T12:00:00Z");
const activePreloadTargetDate = new Date("2026-07-20T00:00:00Z");
const preloadRequests = datasetPreloadRequests(DATASETS, {
  activeDatasetId: "weatherzarr-ecmwf-ifs",
  targetDate: preloadTargetDate,
  activeDatasetTargetDate: activePreloadTargetDate,
});
assert.equal(preloadRequests[0]?.role, "series");
assert.equal(
  preloadRequests.find(
    (request) =>
      request.datasetId === "weatherzarr-ecmwf-ifs"
      && request.role === "series",
  )?.targetDate,
  activePreloadTargetDate,
);
assert.equal(
  preloadRequests.some(
    (request) =>
      request.datasetId === "weatherzarr-ecmwf-ifs"
      && request.role === "map",
  ),
  false,
);
assert.equal(
  preloadRequests.some(
    (request) => getDataset(request.datasetId).sources[request.role]?.auth,
  ),
  false,
);
assert.equal(
  datasetPreloadRequests(DATASETS, {
    activeDatasetId: "weatherzarr-ecmwf-ifs",
    includeAuthenticated: true,
  }).some(
    (request) => getDataset(request.datasetId).sources[request.role]?.auth,
  ),
  true,
);

let activePreloads = 0;
let maximumActivePreloads = 0;
let completedPreloads = 0;
const preloadFailures = await runDatasetPreloads(
  preloadRequests.slice(0, 5),
  async () => {
    activePreloads += 1;
    maximumActivePreloads = Math.max(maximumActivePreloads, activePreloads);
    await new Promise((resolve) => setTimeout(resolve, 2));
    activePreloads -= 1;
    completedPreloads += 1;
    if (completedPreloads === 2) throw new Error("expected preload failure");
  },
  2,
);
assert.equal(maximumActivePreloads, 2);
assert.equal(completedPreloads, 5);
assert.equal(preloadFailures.length, 1);

console.log("Viewer policy checks passed");
