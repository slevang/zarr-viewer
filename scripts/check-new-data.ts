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
  virtualMaps: resolved,
});
