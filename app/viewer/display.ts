import type { VariableConfig } from "../data/types";
import { PRECIPITATION_RATE_DEFAULT_MAX_MM_H } from "../precipitation";

export type LoadState = { phase: "loading" | "ready" | "error"; message: string };

const COLOR_RANGE_ESTIMATOR_VERSION = 6;

export function loadingState(message = "Loading…"): LoadState {
  return { phase: "loading", message };
}

export function errorState(error: unknown): LoadState {
  return { phase: "error", message: error instanceof Error ? error.message : String(error) };
}

export function formatUtcTime(date: Date) {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatOptionalValue(
  value: number | null,
  unit: string,
  decimals = 1,
) {
  return value === null ? "—" : `${value.toFixed(decimals)} ${unit}`;
}

export function firstFinite(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    for (const item of Array.from(value as ArrayLike<unknown>)) {
      const match = firstFinite(item);
      if (match !== undefined) return match;
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const match = firstFinite(item);
      if (match !== undefined) return match;
    }
  }
  return undefined;
}

export function decimalsForRange([min, max]: readonly [number, number]) {
  const width = Math.abs(max - min);
  if (width >= 1000) return 0;
  if (width >= 10) return 1;
  if (width >= 1) return 2;
  return 3;
}

export function formatRangeValue(
  value: number,
  range: readonly [number, number],
) {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  const width = Math.abs(range[1] - range[0]);
  if (
    magnitude < 0.001
    || magnitude >= 1_000_000
    || (width > 0 && width < 0.001)
  ) {
    return value.toExponential(2);
  }
  return value.toFixed(decimalsForRange(range));
}

export function roundToSignificant(value: number, digits = 6) {
  return value === 0 ? 0 : Number(value.toPrecision(digits));
}

export function roundRangeToSignificant(
  range: readonly [number, number],
): [number, number] {
  return [
    roundToSignificant(range[0]),
    roundToSignificant(range[1]),
  ];
}

export function initialDisplayRange(
  variable: VariableConfig,
  valueUnit = variable.unit,
): [number, number] {
  const name = `${variable.id} ${variable.label}`.toLowerCase();
  const unit = valueUnit.toLowerCase();
  if (name.includes("wind direction")) return [0, 360];
  if (name.includes("degree days")) return [0, 25];
  if (
    name.includes("temperature")
    || name.includes("dew point")
    || name.includes("heat index")
    || name.includes("wind chill")
  ) {
    return unit.includes("celsius") || unit.includes("°c")
      ? [-40, 40]
      : [230, 320];
  }
  if (name.includes("relative humidity") || unit === "%") return [0, 100];
  if (name.includes("cloud") && (unit === "1" || unit === "")) return [0, 1];
  if (name.includes("pressure")) {
    return unit.includes("hpa") || unit.includes("millibar")
      ? [900, 1050]
      : [90_000, 105_000];
  }
  if (name.includes("precip") || name.includes("rainfall") || name.includes("snowfall")) {
    if (unit === "mm/h" || unit === "mm/hr") {
      return [0, PRECIPITATION_RATE_DEFAULT_MAX_MM_H];
    }
    if (/^(?:m|meter|metre)s?$/.test(unit)) return [0, 0.025];
    if (unit.includes("inch") || unit === "in") return [0, 1];
    return [0, 25];
  }
  if (name.includes("wind") && /\b(?:u|v)\b/.test(name)) return [-30, 30];
  if (name.includes("wind")) return [0, 30];
  if (name.includes("geopotential height")) return [0, 6_000];
  return [0, 1];
}

export function displayRangeKey(datasetId: string, variableId: string) {
  return `${COLOR_RANGE_ESTIMATOR_VERSION}:${datasetId}:${variableId}`;
}
