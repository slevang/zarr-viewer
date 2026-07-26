import Qty from "js-quantities";
import type { PointSeries } from "./data/types";

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
  degree_day: [
    { id: "degreeDayK", label: "K·day" },
    { id: "degreeDayC", label: "°C·day" },
    { id: "degreeDayF", label: "°F·day" },
  ],
  angle: [
    { id: "deg", label: "°" },
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
  degree_day_k: "degreeDayK",
  degree_day_c: "degreeDayC",
  degree_day_f: "degreeDayF",
  degreedayk: "degreeDayK",
  degreedayc: "degreeDayC",
  degreedayf: "degreeDayF",
};

const converterCache = new Map<string, (value: number) => number>();
const SPECIAL_UNITS: Record<string, { kind: string; factor: number }> = {
  degreeDayK: { kind: "degree_day", factor: 1 },
  degreeDayC: { kind: "degree_day", factor: 1 },
  degreeDayF: { kind: "degree_day", factor: 5 / 9 },
};

export function normalizeUnit(unit: string) {
  const trimmed = unit.trim();
  if (!trimmed) return null;
  const aliased = UNIT_ALIASES[trimmed.toLowerCase()];
  if (aliased && SPECIAL_UNITS[aliased]) return aliased;
  if (SPECIAL_UNITS[trimmed]) return trimmed;
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
  if (!normalized || SPECIAL_UNITS[normalized]) return null;
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
  const normalized = normalizeUnit(unit);
  const specialKind = normalized ? SPECIAL_UNITS[normalized]?.kind : undefined;
  if (specialKind) return specialKind;
  const kind = parsedUnit(unit)?.kind();
  return kind === "length" && isPrecipitation(context)
    ? "precipitation"
    : kind;
}

export function unitOptions(unit: string, context = ""): UnitOption[] {
  const normalized = normalizeUnit(unit);
  const special = normalized ? SPECIAL_UNITS[normalized] : undefined;
  if (special) return [...(DISPLAY_UNITS[special.kind] ?? [])];
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

export function unitConverter(
  sourceUnit: string,
  targetUnit: string,
): ((value: number) => number) | null {
  const source = normalizeUnit(sourceUnit);
  const target = normalizeUnit(targetUnit);
  if (!source || !target) return null;
  if (source === target) return (value) => value;
  const sourceSpecial = SPECIAL_UNITS[source];
  const targetSpecial = SPECIAL_UNITS[target];
  if (sourceSpecial || targetSpecial) {
    if (!sourceSpecial || !targetSpecial || sourceSpecial.kind !== targetSpecial.kind) {
      return null;
    }
    return (value) => value * sourceSpecial.factor / targetSpecial.factor;
  }
  const key = `${source}->${target}`;
  let converter = converterCache.get(key);
  if (!converter) {
    try {
      const swift = Qty.swiftConverter(source, target);
      converter = (candidate) => swift(candidate) as number;
      converterCache.set(key, converter);
    } catch {
      return null;
    }
  }
  return converter;
}

export function unitsCompatible(sourceUnit: string, targetUnit: string) {
  return unitConverter(sourceUnit, targetUnit) !== null;
}

export function convertUnitValue(
  value: number,
  sourceUnit: string,
  targetUnit: string,
) {
  if (!Number.isFinite(value)) return value;
  const converter = unitConverter(sourceUnit, targetUnit);
  if (!converter) return value;
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
  if (!target || !unitsCompatible(series.unit, target.id)) {
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
