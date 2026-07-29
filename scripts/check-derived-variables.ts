import * as zarr from "zarrita";
import type { Readable } from "zarrita";
import { observationVariable } from "../app/asos";
import type { AsosRecord } from "../app/asos-types";
import { getDataset } from "../app/catalog";
import {
  derivedVariableMatches,
  executeDerivedPipeline,
} from "../app/derived-variables";
import {
  derivedLayerOptions,
} from "../app/derived-store";
import {
  loadPointSeries,
  preloadPointSeriesCoordinates,
} from "../app/data/point-series";
import type {
  StoreInfo,
  VariableConfig,
} from "../app/data/types";

function close(actual: number, expected: number, tolerance = 1e-5) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`Expected ${expected}; received ${actual}`);
  }
}

function nativeVariable(
  id: string,
  unit: string,
  label = id,
): VariableConfig {
  return {
    id,
    label,
    unit,
    dimensions: ["time", "latitude", "longitude"],
    shape: [1, 2, 3],
    chunkShape: [1, 2, 2],
    dataType: "float32",
  };
}

const nativeVariables = [
  nativeVariable("t2m", "degree_Celsius", "2 metre temperature"),
  nativeVariable("d2m", "degree_Celsius", "2 metre dew point"),
  nativeVariable("u10", "m/s", "10 metre U wind"),
  nativeVariable("v10", "m/s", "10 metre V wind"),
];
const derived = derivedVariableMatches(nativeVariables);
const expectedDerived = [
  "wind_speed_10m",
  "wind_direction_10m",
  "cdd_65f",
  "hdd_65f",
  "relative_humidity_2m",
  "heat_index",
  "wind_chill",
];
if (
  derived.map((variable) => variable.derived?.key).join(",")
  !== expectedDerived.join(",")
) {
  throw new Error("The derived catalog did not expose all compatible variables");
}

function calculate(
  key: string,
  values: Record<string, ArrayLike<number>>,
) {
  const variable = derived.find((candidate) => candidate.derived?.key === key);
  if (!variable) throw new Error(`Missing derived variable ${key}`);
  return executeDerivedPipeline(variable, nativeVariables, values);
}

close(calculate("wind_speed_10m", {
  u: [3],
  v: [4],
}).values[0], 5);
close(calculate("wind_direction_10m", {
  u: [-1],
  v: [0],
}).values[0], 90);
close(calculate("cdd_65f", {
  temperature: [30],
}).values[0], 30 - (65 - 32) * 5 / 9);
close(calculate("hdd_65f", {
  temperature: [0],
}).values[0], (65 - 32) * 5 / 9);
close(calculate("relative_humidity_2m", {
  temperature: [30],
  dew_point: [20],
}).values[0], 55.08, 0.1);
close(calculate("relative_humidity_2m", {
  temperature: [20],
  dew_point: [25],
}).values[0], 100);

const heatIndex = calculate("heat_index", {
  temperature: [(90 - 32) * 5 / 9],
  dew_point: [(79 - 32) * 5 / 9],
}).values[0];
close((heatIndex - 273.15) * 9 / 5 + 32, 105.9, 1);

const windChill = calculate("wind_chill", {
  temperature: [0],
  u: [10],
  v: [0],
}).values[0];
close(windChill - 273.15, -7.05, 0.15);

const stationRecord: AsosRecord = {
  valid: new Date("2026-01-01T00:00:00Z"),
  tmpc: 30,
  dwpc: 20,
  relh: 55,
  drct: 270,
  sknt: 10,
  gust: null,
  mslp: 1012,
  vsby: 10,
  p01m: 0,
};
function stationDerived(key: string) {
  const variable = derived.find((candidate) => candidate.derived?.key === key);
  if (!variable) throw new Error(`Missing station derived variable ${key}`);
  const observed = observationVariable(variable);
  if (!observed) throw new Error(`ASOS did not recognize derived variable ${key}`);
  return {
    unit: observed.unit,
    value: observed.values([stationRecord])[0],
  };
}
const stationWindSpeed = stationDerived("wind_speed_10m");
close(stationWindSpeed.value ?? NaN, 10 * 0.514444, 1e-4);
if (stationWindSpeed.unit !== "m/s") {
  throw new Error(`Unexpected station wind unit ${stationWindSpeed.unit}`);
}
close(stationDerived("wind_direction_10m").value ?? NaN, 270);
close(
  stationDerived("cdd_65f").value ?? NaN,
  30 - (65 - 32) * 5 / 9,
);
const stationRelativeHumidity = stationDerived("relative_humidity_2m");
close(stationRelativeHumidity.value ?? NaN, 55.08, 0.1);
if (stationRelativeHumidity.unit !== "%") {
  throw new Error(
    `Unexpected station relative-humidity unit ${stationRelativeHumidity.unit}`,
  );
}
if (!Number.isFinite(stationDerived("heat_index").value)) {
  throw new Error("ASOS heat index was not derived");
}
if (!Number.isFinite(stationDerived("wind_chill").value)) {
  throw new Error("ASOS wind chill was not derived");
}

function metadata(
  shape: number[],
  chunks: number[],
  dimensions: string[],
) {
  return {
    shape,
    data_type: "float32",
    chunk_grid: {
      name: "regular",
      configuration: { chunk_shape: chunks },
    },
    chunk_key_encoding: {
      name: "default",
      configuration: { separator: "/" },
    },
    fill_value: "NaN",
    codecs: [{
      name: "bytes",
      configuration: { endian: "little" },
    }],
    attributes: {},
    dimension_names: dimensions,
    zarr_format: 3,
    node_type: "array",
    storage_transformers: [],
  };
}

function bytes(values: Float32Array) {
  return new Uint8Array(values.buffer.slice(0));
}

const sourceMetadata = Object.fromEntries(nativeVariables.map((variable) => [
  variable.id,
  {
    ...metadata(
      variable.shape ?? [],
      variable.chunkShape ?? [],
      variable.dimensions,
    ),
    attributes: { units: variable.unit },
  },
]));
sourceMetadata.latitude = {
  ...metadata([2], [2], ["latitude"]),
  attributes: { units: "degrees_north" },
};
sourceMetadata.longitude = {
  ...metadata([3], [3], ["longitude"]),
  attributes: { units: "degrees_east" },
};
const sourceRoot = new TextEncoder().encode(JSON.stringify({
  attributes: {},
  zarr_format: 3,
  consolidated_metadata: {
    kind: "inline",
    must_understand: false,
    metadata: sourceMetadata,
  },
  node_type: "group",
}));
const sourceChunks = new Map<string, Uint8Array>([
  ["/zarr.json", sourceRoot],
  ["/t2m/c/0/0/0", bytes(new Float32Array([20, 20, 20, 20]))],
  ["/d2m/c/0/0/0", bytes(new Float32Array([10, 10, 10, 10]))],
  ["/u10/c/0/0/0", bytes(new Float32Array([3, 0, -1, 6]))],
  ["/v10/c/0/0/0", bytes(new Float32Array([4, -1, 0, 8]))],
  ["/u10/c/0/0/1", bytes(new Float32Array([5, NaN, 12, NaN]))],
  ["/v10/c/0/0/1", bytes(new Float32Array([12, NaN, 5, NaN]))],
  ["/latitude/c/0", bytes(new Float32Array([0, 1]))],
  ["/longitude/c/0", bytes(new Float32Array([0, 1, 2]))],
]);
for (const [id, entry] of Object.entries(sourceMetadata)) {
  sourceChunks.set(
    `/${id}/zarr.json`,
    new TextEncoder().encode(JSON.stringify(entry)),
  );
}
const sourceReadCounts = new Map<string, number>();
const sourceStore: Readable = {
  get(key) {
    const path = String(key);
    sourceReadCounts.set(path, (sourceReadCounts.get(path) ?? 0) + 1);
    return Promise.resolve(sourceChunks.get(path));
  },
};
const dataset = getDataset("weatherzarr-ecmwf-ifs");
const source = dataset.sources.map!;
const info: StoreInfo = {
  dataset,
  source,
  role: "series",
  variables: nativeVariables,
  derivedVariables: derived,
  axes: {
    time: {
      id: "time",
      label: "Time",
      unit: "hours since 2000-01-01 00:00:00",
      kind: "time",
      values: [0],
    },
  },
  store: sourceStore,
  layerOptions: {
    store: sourceStore,
    zarrVersion: 3,
    crs: "EPSG:4326",
    bounds: [-180, -90, 180, 90],
    spatialDimensions: { lat: "latitude", lon: "longitude" },
    latIsAscending: true,
  },
};
const windSpeedVariable = derived.find(
  (variable) => variable.derived?.key === "wind_speed_10m",
);
if (!windSpeedVariable) throw new Error("Missing wind-speed variable");
const layerOptions = await derivedLayerOptions(info, windSpeedVariable);
if (!layerOptions.store) throw new Error("Derived layer did not provide a store");
const windSpeedArray = await zarr.open(
  zarr.root(layerOptions.store).resolve(windSpeedVariable.id),
  { kind: "array" },
);
const windSpeedValues = await zarr.get(windSpeedArray);
const expectedWindSpeed = [5, 1, 13, 1, 10, 13];
Array.from(windSpeedValues.data as ArrayLike<number>).forEach(
  (value, index) => close(value, expectedWindSpeed[index]),
);

sourceReadCounts.clear();
await preloadPointSeriesCoordinates(info);
const windSpeedSeries = await loadPointSeries(
  info,
  windSpeedVariable,
  { time: 0 },
  0,
  0,
);
if (!windSpeedSeries || windSpeedSeries.kind !== "history") {
  throw new Error("Derived point timeseries did not load");
}
close(windSpeedSeries.values[0], 5);
if (windSpeedSeries.unit !== "m/s") {
  throw new Error(`Unexpected derived series unit ${windSpeedSeries.unit}`);
}
await loadPointSeries(info, windSpeedVariable, { time: 0 }, 1, 1);
for (const dimension of ["latitude", "longitude"]) {
  const reads = sourceReadCounts.get(`/${dimension}/c/0`) ?? 0;
  if (reads !== 1) {
    throw new Error(
      `Expected one cached ${dimension} coordinate read; received ${reads}`,
    );
  }
}

console.log("Derived variable checks passed");
