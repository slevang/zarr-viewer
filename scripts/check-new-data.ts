import assert from "node:assert/strict";
import * as zarr from "zarrita";
import { getDataset } from "../app/catalog";
import { defaultSelections, loadStoreInfo } from "../app/dataset";
import { isSpatialDimension } from "../app/data/dimensions";

function scalarValue(result: unknown) {
  const data = result && typeof result === "object" && "data" in result
    ? result.data
    : result;
  return Array.isArray(data) || ArrayBuffer.isView(data)
    ? Number((data as ArrayLike<number | bigint>)[0])
    : Number(data);
}

const weatherNext = await loadStoreInfo("google-weathernext-2", "map");
assert.equal(weatherNext.source.kind, "icechunk");
assert.equal(weatherNext.source.requiresCrossOriginIsolation, false);
assert.equal(weatherNext.source.auth, undefined);
assert.ok(weatherNext.variables.some((variable) => variable.id === "temperature_2m"));
for (const axis of ["init_time", "lead_time", "ensemble_member"]) {
  assert.ok(weatherNext.axes[axis], `WeatherNext 2 is missing ${axis}`);
}
const weatherNextVariable = weatherNext.variables.find(
  (variable) => variable.id === "temperature_2m",
)!;
const weatherNextDefaults = defaultSelections(weatherNext, weatherNextVariable);
assert.equal(
  weatherNextDefaults.init_time,
  weatherNext.axes.init_time.values.length - 1,
);
const weatherNextArray = await zarr.open(
  zarr.root(weatherNext.store!).resolve(weatherNextVariable.id),
  { kind: "array" },
);
const weatherNextSelection = weatherNextVariable.dimensions.map((dimension, index) =>
  isSpatialDimension(dimension, weatherNext.source)
    ? Math.floor((weatherNextVariable.shape?.[index] ?? 1) / 2)
    : weatherNextDefaults[dimension] ?? 0,
);
const weatherNextValue = scalarValue(
  await zarr.get(weatherNextArray, weatherNextSelection),
);
assert.ok(Number.isFinite(weatherNextValue));

const weatherNext3Gridded = await loadStoreInfo("google-weathernext-3", "map");
assert.equal(weatherNext3Gridded.source.kind, "icechunk");
assert.equal(weatherNext3Gridded.source.requiresCrossOriginIsolation, false);
assert.equal(weatherNext3Gridded.source.auth, undefined);
assert.equal(
  weatherNext3Gridded.source.id,
  "google-weathernext3-forecast-15-day-0-1-degree-virtual",
);
assert.ok(weatherNext3Gridded.variables.some((variable) => variable.id === "temperature_2m"));
assert.ok(weatherNext3Gridded.variables.some((variable) => variable.id === "wind_speed_10m"));
for (const axis of ["init_time", "lead_time", "statistic"]) {
  assert.ok(weatherNext3Gridded.axes[axis], `WeatherNext 3 is missing ${axis}`);
}
assert.deepEqual(
  weatherNext3Gridded.axes.statistic.values.map(String),
  ["mean", "p10", "p25", "p50", "p75", "p90"],
);
const weatherNext3Variable = weatherNext3Gridded.variables.find(
  (variable) => variable.id === "temperature_2m",
)!;
const weatherNext3Defaults = defaultSelections(weatherNext3Gridded, weatherNext3Variable);
// The newest WN3 initialization can be published before all of its chunks
// arrive. Use the preceding run for a stable finite-value smoke check.
weatherNext3Defaults.init_time = Math.max(
  0,
  weatherNext3Gridded.axes.init_time.values.length - 2,
);
const weatherNext3Array = await zarr.open(
  zarr.root(weatherNext3Gridded.store!).resolve(weatherNext3Variable.id),
  { kind: "array" },
);
const weatherNext3Selection = weatherNext3Variable.dimensions.map((dimension, index) =>
  isSpatialDimension(dimension, weatherNext3Gridded.source)
    ? Math.floor((weatherNext3Variable.shape?.[index] ?? 1) / 2)
    : weatherNext3Defaults[dimension] ?? 0,
);
const weatherNext3Value = scalarValue(
  await zarr.get(weatherNext3Array, weatherNext3Selection),
);
assert.ok(Number.isFinite(weatherNext3Value));

const weatherNext3Station = await loadStoreInfo("google-weathernext-3-station-head", "map");
assert.equal(weatherNext3Station.source.kind, "icechunk");
assert.equal(weatherNext3Station.source.requiresCrossOriginIsolation, false);
assert.equal(weatherNext3Station.source.auth, undefined);
assert.equal(
  weatherNext3Station.source.id,
  "google-weathernext3-forecast-15-day-0-05-degree-virtual",
);
assert.deepEqual(
  weatherNext3Station.variables.map((variable) => variable.id).sort(),
  ["dew_point_temperature_2m", "temperature_2m"],
);
for (const axis of ["init_time", "lead_time", "statistic"]) {
  assert.ok(weatherNext3Station.axes[axis], `WeatherNext 3 station head is missing ${axis}`);
}
assert.deepEqual(
  weatherNext3Station.axes.statistic.values.map(String),
  ["mean", "p10", "p25", "p50", "p75", "p90"],
);
const weatherNext3StationVariable = weatherNext3Station.variables.find(
  (variable) => variable.id === "temperature_2m",
)!;
const weatherNext3StationDefaults = defaultSelections(
  weatherNext3Station,
  weatherNext3StationVariable,
);
weatherNext3StationDefaults.init_time = Math.max(
  0,
  weatherNext3Station.axes.init_time.values.length - 2,
);
const weatherNext3StationArray = await zarr.open(
  zarr.root(weatherNext3Station.store!).resolve(weatherNext3StationVariable.id),
  { kind: "array" },
);
const weatherNext3StationSelection = weatherNext3StationVariable.dimensions.map((dimension, index) =>
  isSpatialDimension(dimension, weatherNext3Station.source)
    ? Math.floor((weatherNext3StationVariable.shape?.[index] ?? 1) / 2)
    : weatherNext3StationDefaults[dimension] ?? 0,
);
const weatherNext3StationValue = scalarValue(
  await zarr.get(weatherNext3StationArray, weatherNext3StationSelection),
);
assert.ok(Number.isFinite(weatherNext3StationValue));

const virtualMaps = [
  "noaa-gfs-forecast",
  "noaa-gefs-analysis",
  "noaa-hrrr-analysis",
];
const resolved = [];
for (const datasetId of virtualMaps) {
  const dataset = getDataset(datasetId);
  const source = dataset.sources.map;
  assert.ok(source?.id.endsWith("-virtual"), `${datasetId} map is not virtual`);
  const info = await loadStoreInfo(datasetId, "map");
  assert.equal(info.source.kind, "icechunk");
  assert.ok(info.variables.length > 0, `${datasetId} reported no variables`);
  const variable = info.variables.find((candidate) => candidate.id === "temperature_2m")
    ?? info.variables.find((candidate) => candidate.shape?.length);
  assert.ok(variable, `${datasetId} reported no readable array variable`);
  const array = await zarr.open(
    zarr.root(info.store!).resolve(variable.id),
    { kind: "array" },
  );
  const selection = variable.dimensions.map((dimension, index) =>
    isSpatialDimension(dimension, info.source)
      ? Math.floor((variable.shape?.[index] ?? 1) / 2)
      : 0,
  );
  const value = scalarValue(await zarr.get(array, selection));
  assert.ok(Number.isFinite(value), `${datasetId} returned a non-finite map value`);
  resolved.push({
    datasetId,
    sourceId: info.source.id,
    resolvedUrl: info.source.url,
    variableCount: info.variables.length,
    variable: variable.id,
    value,
  });
}

console.log({
  weatherNext2: {
    source: weatherNext.source.id,
    value: weatherNextValue,
    axes: Object.fromEntries(
      Object.entries(weatherNext.axes).map(([id, axis]) => [id, axis.values.length]),
    ),
  },
  weatherNext3Gridded: {
    source: weatherNext3Gridded.source.id,
    value: weatherNext3Value,
    statistic: weatherNext3Gridded.axes.statistic.values[weatherNext3Defaults.statistic ?? 0],
    axes: Object.fromEntries(
      Object.entries(weatherNext3Gridded.axes).map(([id, axis]) => [id, axis.values.length]),
    ),
  },
  weatherNext3Station: {
    source: weatherNext3Station.source.id,
    value: weatherNext3StationValue,
    statistic: weatherNext3Station.axes.statistic.values[weatherNext3StationDefaults.statistic ?? 0],
    axes: Object.fromEntries(
      Object.entries(weatherNext3Station.axes).map(([id, axis]) => [id, axis.values.length]),
    ),
  },
  virtualMaps: resolved,
});
