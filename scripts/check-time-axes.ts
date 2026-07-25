import assert from "node:assert/strict";
import type { DatasetConfig } from "../app/catalog";
import {
  axisValueAsDate,
  type AxisConfig,
} from "../app/dataset";

const dataset = {
  id: "time-axis-check",
  label: "Time axis check",
  provider: "dynamical.org",
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

console.log("Time-axis checks passed");
