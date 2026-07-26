import type { VariableConfig } from "./dataset";

export type FiniteValueSample = {
  values: number[];
  seen: number;
  randomState: number;
  limit: number;
};

export function createFiniteValueSample(limit = 120_000): FiniteValueSample {
  return {
    values: [],
    seen: 0,
    randomState: 0x6d2b79f5,
    limit,
  };
}

export function addFiniteValues(
  sample: FiniteValueSample,
  value: unknown,
) {
  const add = (numeric: number) => {
    if (!Number.isFinite(numeric)) return;
    sample.seen += 1;
    if (sample.values.length < sample.limit) {
      sample.values.push(numeric);
      return;
    }
    sample.randomState = (
      Math.imul(sample.randomState, 1_664_525) + 1_013_904_223
    ) >>> 0;
    const replacement = Math.floor(
      (sample.randomState / 0x1_0000_0000) * sample.seen,
    );
    if (replacement < sample.limit) sample.values[replacement] = numeric;
  };

  const visit = (candidate: unknown) => {
    if (typeof candidate === "number") {
      add(candidate);
      return;
    }
    if (typeof candidate === "bigint") {
      add(Number(candidate));
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (ArrayBuffer.isView(candidate) && "length" in candidate) {
      const values = candidate as unknown as ArrayLike<number | bigint>;
      for (let index = 0; index < values.length; index += 1) {
        const item = values[index];
        add(typeof item === "bigint" ? Number(item) : item);
      }
    }
  };

  visit(value);
}

function quantile(sorted: number[], probability: number) {
  if (sorted.length === 1) return sorted[0];
  const position = Math.max(0, Math.min(1, probability))
    * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
}

function variableName(variable: VariableConfig) {
  return [
    variable.id,
    variable.label,
    variable.standardName ?? "",
  ].join(" ").toLowerCase();
}

function isPrecipitation(variable: VariableConfig) {
  const name = variableName(variable);
  return (
    variable.id.toLowerCase() === "tp"
    || variable.id.toLowerCase() === "pr"
    || name.includes("precip")
    || name.includes("rainfall")
    || name.includes("snowfall")
  );
}

function isTemperature(variable: VariableConfig) {
  const name = variableName(variable);
  const id = variable.id.toLowerCase();
  return (
    id === "t2m"
    || id === "d2m"
    || name.includes("temperature")
    || name.includes("dew point")
    || name.includes("heat index")
    || name.includes("wind chill")
  );
}

function startsAtZero(variable: VariableConfig) {
  const name = variableName(variable);
  return (
    isPrecipitation(variable)
    || name.includes("wind speed")
    || name.includes("degree day")
    || name.includes("cdd")
    || name.includes("hdd")
  );
}

export function robustColorRange(
  sample: FiniteValueSample,
  variable: VariableConfig,
): [number, number] | null {
  if (!sample.values.length) return null;
  const sorted = [...sample.values].sort((left, right) => left - right);
  const observedMin = sorted[0];
  const observedMax = sorted[sorted.length - 1];
  const name = variableName(variable);

  if (name.includes("wind direction")) return [0, 360];

  let lower: number;
  let upper: number;
  if (isPrecipitation(variable)) {
    const positive = sorted.filter((value) => value > 0);
    if (!positive.length) return null;
    lower = 0;
    const wetPixelUpper = quantile(positive, 0.95);
    upper = Math.min(
      positive[positive.length - 1],
      wetPixelUpper * 1.05,
    );
  } else {
    const temperature = isTemperature(variable);
    const centralLow = quantile(sorted, temperature ? 0.1 : 0.05);
    const centralHigh = quantile(sorted, temperature ? 0.99 : 0.95);
    const centralSpan = centralHigh - centralLow;
    const lowerPaddingFraction = temperature ? 0.05 : 0.1;
    const upperPaddingFraction = temperature ? 0.08 : 0.1;
    lower = startsAtZero(variable)
      ? 0
      : Math.max(
        observedMin,
        centralLow - centralSpan * lowerPaddingFraction,
      );
    upper = Math.min(
      observedMax,
      centralHigh + centralSpan * upperPaddingFraction,
    );
  }

  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return null;
  if (upper <= lower) {
    lower = startsAtZero(variable) ? 0 : observedMin;
    upper = observedMax;
  }
  if (upper <= lower) {
    const padding = Math.abs(lower) * 0.05 || 1;
    return [lower - padding, upper + padding];
  }
  return [lower, upper];
}
