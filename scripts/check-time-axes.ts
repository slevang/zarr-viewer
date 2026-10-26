import assert from "node:assert/strict";
import { getDataset, type DatasetConfig } from "../app/catalog";
import {
  axisDateMatch,
  axisIndexForDate,
  axisValueAsDate,
  defaultSelections,
  preserveForecastLeadSelection,
  selectionsAfterAxisChange,
  selectionsForValidDate,
  selectorFor,
  selectedValidDate,
  seriesStartDate,
  sourcePointCoordinates,
  storageIndex,
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
import { playbackChunkKey } from "../app/viewer/playback";
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
const hrrrCoordinates = toDataCoordinates(
  getDataset("noaa-hrrr-forecast-48-hour"),
  -71.5,
  42.9,
);
assert.deepEqual(hrrrCoordinates, [-71.5, 42.9]);
const projectedHrrrCoordinates = sourcePointCoordinates(
  getDataset("noaa-hrrr-forecast-48-hour").sources.series,
  -71.5,
  42.9,
);
assert.ok(Math.abs(projectedHrrrCoordinates[0] - 2_096_161.55) < 1);
assert.ok(Math.abs(projectedHrrrCoordinates[1] - 787_819.67) < 1);

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

const compactEra5Axis: AxisConfig = {
  id: "time",
  label: "Time",
  unit: "hours since 1900-01-01",
  kind: "time",
  storageIndexOffset: 350_616,
  values: [350_616, 350_617],
};
assert.equal(storageIndex(compactEra5Axis, 0), 350_616);
assert.equal(storageIndex(compactEra5Axis, 380_447), 731_063);
assert.equal(storageIndex(compactEra5Axis, 760_895), 1_111_511);
assert.deepEqual(
  [0, 380_447, 760_895].map((index) => storageIndex(compactEra5Axis, index)),
  [350_616, 731_063, 1_111_511],
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
  selectorFor(
    { ...forecastVariable, dimensions: ["time", "latitude", "longitude"] },
    { time: 760_895 },
    { time: compactEra5Axis },
  ),
  { time: { selected: 1_111_511, type: "index" } },
);
assert.equal(
  playbackChunkKey(
    {
      id: "temperature_2m",
      label: "Temperature",
      unit: "K",
      dimensions: ["time", "latitude", "longitude"],
      shape: [1_323_648, 721, 1_440],
      chunkShape: [24, 721, 1_440],
    },
    { time: 760_895 },
    { time: compactEra5Axis },
  ),
  "/temperature_2m/c/46312/0/0",
);
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
