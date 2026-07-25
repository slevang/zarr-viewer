import assert from "node:assert/strict";
import type { DatasetConfig } from "../app/catalog";
import {
  axisDateMatch,
  axisIndexForDate,
  axisValueAsDate,
  selectionsAfterAxisChange,
  selectionsForValidDate,
  selectedValidDate,
  type AxisConfig,
  type StoreInfo,
  type VariableConfig,
} from "../app/dataset";

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

console.log("Time-axis checks passed");
