import Qty from "js-quantities";
import type { PointSeries } from "./dataset";

export type UnitOption = {
  id: string;
  label: string;
};

const DISPLAY_UNITS: Record<string, UnitOption[]> = {
  temperature: [
    { id: "tempK", label: "K" },
    { id: "tempC", label: "°C" },
    { id: "tempF", label: "°F" },
  ],
  pressure: [
    { id: "Pa", label: "Pa" },
    { id: "hPa", label: "hPa" },
    { id: "kPa", label: "kPa" },
    { id: "bar", label: "bar" },
    { id: "psi", label: "psi" },
    { id: "inHg", label: "inHg" },
  ],
  speed: [
    { id: "m/s", label: "m/s" },
    { id: "kph", label: "km/h" },
    { id: "mph", label: "mph" },
    { id: "knot", label: "kt" },
  ],
  length: [
    { id: "m", label: "m" },
    { id: "km", label: "km" },
    { id: "ft", label: "ft" },
    { id: "mi", label: "mi" },
  ],
  precipitation: [
    { id: "m", label: "m" },
    { id: "mm", label: "mm" },
    { id: "in", label: "in" },
  ],
};

const UNIT_ALIASES: Record<string, string> = {
  k: "tempK",
  kelvin: "tempK",
  degree_kelvin: "tempK",
  degrees_kelvin: "tempK",
  degk: "tempK",
  tempk: "tempK",
  "°k": "tempK",
  celsius: "tempC",
  degree_celsius: "tempC",
  degrees_celsius: "tempC",
  degc: "tempC",
  tempc: "tempC",
  "°c": "tempC",
  fahrenheit: "tempF",
  degree_fahrenheit: "tempF",
  degrees_fahrenheit: "tempF",
  degf: "tempF",
  tempf: "tempF",
  "°f": "tempF",
};

const converterCache = new Map<string, (value: number) => number>();

export function normalizeUnit(unit: string) {
  const trimmed = unit.trim();
  if (!trimmed) return null;
  const aliased = UNIT_ALIASES[trimmed.toLowerCase()];
  const candidates = [
    aliased,
    trimmed,
    trimmed
      .replaceAll("**", "^")
      .replaceAll(" per ", "/")
      .replaceAll(/degrees?/gi, "degree"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      return Qty(1, candidate).units();
    } catch {
      // Try the next CF spelling.
    }
  }
  return null;
}

function parsedUnit(unit: string) {
  const normalized = normalizeUnit(unit);
  if (!normalized) return null;
  try {
    return Qty(1, normalized);
  } catch {
    return null;
  }
}

function isPrecipitation(context = "") {
  return /(precip|rainfall|snowfall|water[_ ]equivalent)/i.test(context);
}

export function unitKind(unit: string, context = "") {
  const kind = parsedUnit(unit)?.kind();
  return kind === "length" && isPrecipitation(context)
    ? "precipitation"
    : kind;
}

export function unitOptions(unit: string, context = ""): UnitOption[] {
  const source = parsedUnit(unit);
  if (!source) return [];
  const preferred = DISPLAY_UNITS[unitKind(unit, context) ?? ""] ?? [];
  const compatible = preferred.filter((candidate) => {
    try {
      return source.isCompatible(Qty(1, candidate.id));
    } catch {
      return false;
    }
  });
  if (!compatible.length) return [];

  const normalized = normalizeUnit(unit);
  if (
    normalized
    && !compatible.some((candidate) => candidate.id === normalized)
  ) {
    compatible.unshift({ id: normalized, label: unit });
  }
  return compatible;
}

export function nativeUnitOption(unit: string, context = "") {
  const normalized = normalizeUnit(unit);
  if (!normalized) return null;
  return unitOptions(unit, context).find((candidate) => candidate.id === normalized)
    ?? { id: normalized, label: unit };
}

export function convertUnitValue(
  value: number,
  sourceUnit: string,
  targetUnit: string,
) {
  if (!Number.isFinite(value)) return value;
  const source = normalizeUnit(sourceUnit);
  const target = normalizeUnit(targetUnit);
  if (!source || !target || source === target) return value;
  const key = `${source}->${target}`;
  let converter = converterCache.get(key);
  if (!converter) {
    try {
      const swift = Qty.swiftConverter(source, target);
      converter = (candidate) => swift(candidate) as number;
      converterCache.set(key, converter);
    } catch {
      return value;
    }
  }
  try {
    return converter(value);
  } catch {
    return value;
  }
}

export function convertUnitRange(
  range: [number, number],
  sourceUnit: string,
  targetUnit: string,
): [number, number] {
  const first = convertUnitValue(range[0], sourceUnit, targetUnit);
  const second = convertUnitValue(range[1], sourceUnit, targetUnit);
  return first <= second ? [first, second] : [second, first];
}

export function convertPointSeries(
  series: PointSeries,
  target: UnitOption | null,
): PointSeries {
  if (!target || !parsedUnit(series.unit)?.isCompatible(Qty(1, target.id))) {
    return series;
  }
  const convert = (value: number) =>
    convertUnitValue(value, series.unit, target.id);
  if (series.kind === "history") {
    return {
      ...series,
      values: series.values.map(convert),
      unit: target.label,
    };
  }
  return {
    ...series,
    quantiles: series.quantiles.map((quantiles) => ({
      min: convert(quantiles.min),
      q10: convert(quantiles.q10),
      q25: convert(quantiles.q25),
      q50: convert(quantiles.q50),
      q75: convert(quantiles.q75),
      q90: convert(quantiles.q90),
      max: convert(quantiles.max),
    })),
    unit: target.label,
  };
}
