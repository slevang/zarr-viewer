import assert from "node:assert/strict";
import { getDataset, type DatasetConfig } from "../app/catalog";
import {
  axisDateMatch,
  axisIndexForDate,
  axisValueAsDate,
  defaultSelections,
  preserveForecastLeadSelection,
  regularSpatialCoordinateValues,
  selectionsAfterAxisChange,
  selectionsForValidDate,
  selectorFor,
  selectedValidDate,
  seriesStartDate,
  toDataCoordinates,
  validDateRange,
} from "../app/data/axes";
import {
  hasSpatialDimensions,
  isEnsembleDimension,
  isInitializationDimension,
} from "../app/data/dimensions";
import type {
  AxisConfig,
  StoreInfo,
  VariableConfig,
} from "../app/data/types";
import { weatherNextStoreUrl } from "../app/dataset";

const weatherNextRoot =
  "https://storage.googleapis.com/weathernext/weathernext_2_0_0/zarr";
assert.equal(
  weatherNextStoreUrl(weatherNextRoot, new Date("2026-07-25T18:00:00Z")),
  `${weatherNextRoot}/2025_to_present/20260725_18hr_01_preds/predictions.zarr`,
);
assert.equal(
  weatherNextStoreUrl(weatherNextRoot, new Date("2024-02-03T18:00:00Z")),
  `${weatherNextRoot}/2024_to_2025/20240203_18hr_01_preds/predictions.zarr`,
);
assert.equal(
  weatherNextStoreUrl(weatherNextRoot, new Date("2024-02-03T07:59:00Z")),
  `${weatherNextRoot}/2024_to_2025/20240203_06hr_01_preds/predictions.zarr`,
);
assert.equal(
  hasSpatialDimensions(
    ["time", "northing", "easting"],
    { spatialDimensions: { lat: "northing", lon: "easting" } },
  ),
  true,
);
assert.equal(isInitializationDimension("Forecast_Date"), true);
assert.equal(isEnsembleDimension("number"), true);

assert.deepEqual(
  toDataCoordinates(getDataset("google-arco-era5"), -98, 38.5),
  [262, 38.5],
);
assert.deepEqual(
  toDataCoordinates(getDataset("weatherzarr-ecmwf-ifs"), -98, 38.5),
  [-98, 38.5],
);
const weatherZarrSource = getDataset(
  "weatherzarr-ecmwf-ifs",
).sources.map!;
assert.deepEqual(
  regularSpatialCoordinateValues(weatherZarrSource, "latitude", 3),
  [90, 0, -90],
);
assert.deepEqual(
  regularSpatialCoordinateValues(weatherZarrSource, "longitude", 4),
  [-180, -90, 0, 90],
);
assert.equal(
  regularSpatialCoordinateValues(weatherZarrSource, "valid_time", 57),
  undefined,
);

const dataset = {
  id: "time-axis-check",
  label: "Time axis check",
  provider: "dynamical.org",
  category: "analysis",
  description: "",
  sources: {},
  support: "ready",
} satisfies DatasetConfig;

function timeAxis(unit: string, value: number): AxisConfig {
  return {
    id: "time",
    label: "Time",
    unit,
    kind: "time",
    values: [value],
  };
}

assert.equal(
  axisValueAsDate(
    dataset,
    timeAxis("seconds since 1970-01-01 00:00:00", 0),
    0,
  ).toISOString(),
  "1970-01-01T00:00:00.000Z",
);
assert.equal(
  axisValueAsDate(
    dataset,
    timeAxis("hours since 2000-01-01T00:00:00", 6),
    0,
  ).toISOString(),
  "2000-01-01T06:00:00.000Z",
);
assert.equal(
  axisValueAsDate(
    dataset,
    timeAxis("hours since 2000-01-01T00:00:00-06:00", 0),
    0,
  ).toISOString(),
  "2000-01-01T06:00:00.000Z",
);
assert.equal(
  axisValueAsDate(
    dataset,
    timeAxis("microseconds since 1970-01-01 00:00:00 UTC", 1_000_000),
    0,
  ).toISOString(),
  "1970-01-01T00:00:01.000Z",
);
assert.equal(
  axisValueAsDate(
    getDataset("google-arco-era5"),
    timeAxis("hours since 1900-01-01", 24),
    0,
  ).toISOString(),
  "1900-01-02T00:00:00.000Z",
);

const ascendingAxis: AxisConfig = {
  id: "time",
  label: "Time",
  unit: "hours since 2021-02-07T00:00:00",
  kind: "time",
  values: [0, 6, 12, 18],
};
const nearSix = new Date("2021-02-07T05:00:00Z");
assert.equal(axisIndexForDate(dataset, ascendingAxis, nearSix), 1);
assert.deepEqual(
  {
    date: axisDateMatch(dataset, ascendingAxis, nearSix).date.toISOString(),
    distance: axisDateMatch(
      dataset,
      ascendingAxis,
      nearSix,
    ).distanceMilliseconds,
  },
  {
    date: "2021-02-07T06:00:00.000Z",
    distance: 60 * 60 * 1000,
  },
);

const beforeRange = axisDateMatch(
  dataset,
  ascendingAxis,
  new Date("2020-02-07T00:00:00Z"),
);
assert.equal(beforeRange.index, 0);
assert.equal(beforeRange.first.toISOString(), "2021-02-07T00:00:00.000Z");
assert.equal(beforeRange.last.toISOString(), "2021-02-07T18:00:00.000Z");

const forecastInfo = {
  dataset,
  source: {
    id: "forecast",
    kind: "icechunk",
    url: "",
    zarrVersion: 3,
  },
  role: "map",
  variables: [],
  axes: {
    init_time: {
      id: "init_time",
      label: "Initialization",
      unit: "hours since 2021-02-07T00:00:00",
      kind: "time",
      values: [0, 6, 12],
    },
    lead_time: {
      id: "lead_time",
      label: "Lead",
      unit: "hours",
      kind: "timedelta",
      values: [0, 1, 2, 3, 4, 5, 6, 9, 12],
    },
  },
  layerOptions: {
    zarrVersion: 3,
    crs: "EPSG:4326",
  },
} satisfies StoreInfo;
const forecastVariable = {
  id: "temperature_2m",
  label: "Temperature",
  unit: "K",
  dimensions: ["init_time", "lead_time", "latitude", "longitude"],
} satisfies VariableConfig;
assert.deepEqual(
  defaultSelections({
    ...forecastInfo,
    dataset: { ...forecastInfo.dataset, category: "forecast" },
  }, forecastVariable),
  { init_time: 2, lead_time: 1 },
);
const nextForecastInfo = {
  ...forecastInfo,
  axes: {
    ...forecastInfo.axes,
    prediction_timedelta: {
      id: "prediction_timedelta",
      label: "Forecast lead time",
      unit: "hours",
      kind: "timedelta",
      values: [0, 3, 6],
    },
  },
} satisfies StoreInfo;
const nextForecastVariable = {
  ...forecastVariable,
  dimensions: [
    "init_time",
    "prediction_timedelta",
    "latitude",
    "longitude",
  ],
} satisfies VariableConfig;
assert.deepEqual(
  preserveForecastLeadSelection(
    forecastInfo,
    forecastVariable,
    { init_time: 2, lead_time: 1 },
    nextForecastInfo,
    nextForecastVariable,
    { init_time: 2, prediction_timedelta: 0 },
  ),
  { init_time: 2, prediction_timedelta: 1 },
);
assert.deepEqual(
  Object.fromEntries(
    Object.entries(validDateRange(forecastInfo, forecastVariable) ?? {}).map(
      ([key, value]) => [key, value.toISOString()],
    ),
  ),
  {
    first: "2021-02-07T00:00:00.000Z",
    last: "2021-02-08T00:00:00.000Z",
  },
);

const mappedForecast = selectionsForValidDate(
  forecastInfo,
  forecastVariable,
  new Date("2021-02-07T09:00:00Z"),
);
assert.deepEqual(mappedForecast, { init_time: 1, lead_time: 3 });
assert.equal(
  selectedValidDate(
    forecastInfo,
    forecastVariable,
    mappedForecast,
  )?.toISOString(),
  "2021-02-07T09:00:00.000Z",
);
assert.equal(
  seriesStartDate(
    forecastInfo,
    forecastVariable,
    mappedForecast,
  )?.toISOString(),
  "2021-02-07T06:00:00.000Z",
);

const preservedAcrossInitChange = selectionsAfterAxisChange(
  forecastInfo,
  forecastVariable,
  { init_time: 0, lead_time: 8 },
  forecastInfo.axes.init_time,
  1,
);
assert.deepEqual(preservedAcrossInitChange, { init_time: 1, lead_time: 6 });
assert.equal(
  selectedValidDate(
    forecastInfo,
    forecastVariable,
    preservedAcrossInitChange,
  )?.toISOString(),
  "2021-02-07T12:00:00.000Z",
);

const cannotPreserveBeforeInitialization = selectionsAfterAxisChange(
  forecastInfo,
  forecastVariable,
  { init_time: 0, lead_time: 0 },
  forecastInfo.axes.init_time,
  1,
);
assert.deepEqual(cannotPreserveBeforeInitialization, {
  init_time: 1,
  lead_time: 0,
});

const weatherNextInfo = {
  ...forecastInfo,
  source: {
    ...forecastInfo.source,
    kind: "weathernext",
    zarrVersion: 2,
  },
  axes: {
    init_time: {
      ...forecastInfo.axes.init_time,
      defaultIndex: 1,
      requiresStoreReload: true,
    },
    time: {
      id: "time",
      label: "Lead time",
      unit: "hours",
      kind: "timedelta",
      values: [0, 6, 12, 18],
    },
    sample: {
      id: "sample",
      label: "Sample",
      unit: "",
      kind: "number",
      values: [0, 1],
    },
  },
} satisfies StoreInfo;
const weatherNextVariable = {
  ...forecastVariable,
  dimensions: ["sample", "time", "lat", "lon"],
} satisfies VariableConfig;
assert.deepEqual(
  defaultSelections(weatherNextInfo, weatherNextVariable),
  { sample: 0, time: 0, init_time: 1 },
);
const weatherNextAtNoon = selectionsForValidDate(
  weatherNextInfo,
  weatherNextVariable,
  new Date("2021-02-07T12:00:00Z"),
);
assert.deepEqual(weatherNextAtNoon, {
  sample: 0,
  time: 1,
  init_time: 1,
});
assert.equal(
  selectedValidDate(
    weatherNextInfo,
    weatherNextVariable,
    weatherNextAtNoon,
  )?.toISOString(),
  "2021-02-07T12:00:00.000Z",
);
assert.deepEqual(
  selectorFor(weatherNextVariable, weatherNextAtNoon),
  {
    sample: { selected: 0, type: "index" },
    time: { selected: 1, type: "index" },
  },
);

const analysisInfo = {
  ...forecastInfo,
  source: {
    ...forecastInfo.source,
    id: "analysis",
  },
  axes: {
    time: {
      id: "time",
      label: "Time",
      unit: "hours since 2021-02-07T00:00:00",
      kind: "time",
      values: [0, 6, 12],
    },
  },
} satisfies StoreInfo;
const analysisVariable = {
  ...forecastVariable,
  dimensions: ["time", "latitude", "longitude"],
} satisfies VariableConfig;
assert.deepEqual(
  Object.fromEntries(
    Object.entries(validDateRange(analysisInfo, analysisVariable) ?? {}).map(
      ([key, value]) => [key, value.toISOString()],
    ),
  ),
  {
    first: "2021-02-07T00:00:00.000Z",
    last: "2021-02-07T12:00:00.000Z",
  },
);
const mappedAnalysis = selectionsForValidDate(
  analysisInfo,
  analysisVariable,
  selectedValidDate(
    forecastInfo,
    forecastVariable,
    mappedForecast,
  )!,
);
assert.deepEqual(mappedAnalysis, { time: 1 });

const validTimeForecastInfo = {
  ...forecastInfo,
  dataset: {
    ...dataset,
    category: "forecast",
  },
  axes: {
    valid_time: {
      id: "valid_time",
      label: "Valid time",
      unit: "hours since 2026-07-25T12:00:00",
      kind: "time",
      values: [0, 3, 6, 9],
    },
  },
} satisfies StoreInfo;
const validTimeForecastVariable = {
  ...forecastVariable,
  dimensions: ["valid_time", "latitude", "longitude"],
} satisfies VariableConfig;
assert.deepEqual(
  defaultSelections(validTimeForecastInfo, validTimeForecastVariable),
  { valid_time: 0 },
);

const forecastDateInfo = {
  ...forecastInfo,
  axes: {
    forecast_date: {
      id: "forecast_date",
      label: "Forecast date",
      unit: "days since 2021-02-07T00:00:00",
      kind: "time",
      values: [0, 1, 2],
    },
    lead: {
      id: "lead",
      label: "Lead",
      unit: "hours",
      kind: "timedelta",
      values: [0, 6, 12],
    },
  },
} satisfies StoreInfo;
const forecastDateVariable = {
  ...forecastVariable,
  dimensions: ["forecast_date", "lead", "sample", "latitude", "longitude"],
} satisfies VariableConfig;
assert.deepEqual(
  selectionsForValidDate(
    forecastDateInfo,
    forecastDateVariable,
    new Date("2021-02-08T06:00:00Z"),
  ),
  { forecast_date: 1, lead: 1 },
);

console.log("Time-axis checks passed");
