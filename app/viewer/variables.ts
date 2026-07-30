import {
  axisDateMatch,
  axisValueAsDate,
  formatAxisValue,
  isForecastSeries,
} from "../data/axes";
import {
  isEnsembleDimension,
  isInitializationDimension,
  isSpatialDimension,
} from "../data/dimensions";
import { commonVariableMatches } from "../common-variables";
import type {
  AxisConfig,
  AxisSelection,
  PointSeries,
  StoreInfo,
  VariableConfig,
} from "../data/types";

export function axisSummary(
  info: StoreInfo,
  variable: VariableConfig,
  selections: AxisSelection,
) {
  return variable.dimensions.flatMap((dimension) => {
    const axis = info.axes[dimension];
    if (!axis) return [];
    return [`${axis.label}: ${formatAxisValue(info.dataset, axis, selections[dimension] ?? 0)}`];
  }).join(" · ");
}

export function normalizedVariableName(variable: VariableConfig) {
  return `${variable.id} ${variable.label}`
    .toLowerCase()
    .replaceAll("metre", "m")
    .replaceAll("meter", "m")
    .replaceAll(/[^a-z0-9]+/g, "");
}

export function variableConcept(variable: VariableConfig) {
  const name = normalizedVariableName(variable);
  const standardName = variable.standardName?.toLowerCase() ?? "";
  const isTwoMeter = name.includes("2m")
    || variable.id.toLowerCase() === "t2m"
    || variable.id.toLowerCase() === "d2m";
  const isDewPoint = name.includes("dew")
    || standardName.includes("dew_point")
    || variable.id.toLowerCase() === "d2m";
  if (isDewPoint) return isTwoMeter ? "dew_point_2m" : "dew_point";
  const isTemperature = name.includes("temp")
    || standardName === "air_temperature"
    || variable.id.toLowerCase() === "t2m";
  if (isTemperature) return isTwoMeter ? "air_temperature_2m" : "air_temperature";
  return undefined;
}

export function availableVariables(info: StoreInfo) {
  return [...(info.derivedVariables ?? []), ...info.variables];
}

export function matchingVariable(info: StoreInfo, source: VariableConfig) {
  if (source.derived) {
    return info.derivedVariables?.find(
      (candidate) => candidate.derived?.key === source.derived?.key,
    );
  }
  const exact = info.variables.find((candidate) => candidate.id === source.id);
  if (exact) return exact;
  const commonKey = commonVariableMatches([source])[0]?.key;
  const commonMatch = commonKey
    ? commonVariableMatches(info.variables).find(
      (candidate) => candidate.key === commonKey,
    )?.variable
    : undefined;
  if (commonMatch) return commonMatch;
  const standardName = source.standardName?.toLowerCase();
  const sourceName = normalizedVariableName(source);
  const sourceConcept = variableConcept(source);
  const ranked = info.variables.map((candidate) => {
    const candidateName = normalizedVariableName(candidate);
    const candidateConcept = variableConcept(candidate);
    let semanticScore = 0;
    if (sourceConcept && candidateConcept === sourceConcept) {
      semanticScore += 120;
    }
    if (
      (!sourceConcept || !candidateConcept || sourceConcept === candidateConcept)
      && standardName
      && candidate.standardName?.toLowerCase() === standardName
    ) {
      semanticScore += 100;
    }
    if (candidateName === sourceName) semanticScore += 80;
    let score = semanticScore;
    if (semanticScore > 0 && source.unit && candidate.unit === source.unit) score += 5;
    score -= candidate.dimensions.filter((dimension) => {
      const kind = info.axes[dimension]?.kind;
      return kind !== "time"
        && kind !== "timedelta"
        && !isSpatialDimension(dimension, info.source)
        && !isEnsembleDimension(dimension);
    }).length * 2;
    return { candidate, score };
  }).sort((a, b) => b.score - a.score);
  return ranked[0]?.score > 0 ? ranked[0].candidate : undefined;
}

export function seriesCoversDate(series: PointSeries | undefined, date?: Date) {
  if (!series || !date || !series.dates.length) return false;
  const target = date.getTime();
  const first = series.dates[0].getTime();
  const last = series.dates.at(-1)?.getTime() ?? first;
  return target >= Math.min(first, last) && target <= Math.max(first, last);
}

export function isInitializationAxis(axis: AxisConfig) {
  return isInitializationDimension(axis.id);
}

export function utcHour(date: Date) {
  return Number.isFinite(date.getTime())
    ? `${date.toISOString().slice(0, 13).replace("T", " ")}Z`
    : "unknown";
}

export function forecastInitTolerance(
  info: StoreInfo,
  axis: AxisConfig,
  index: number,
) {
  const matched = axisValueAsDate(info.dataset, axis, index).getTime();
  const neighborDistances = [index - 1, index + 1].flatMap((neighbor) => {
    if (neighbor < 0 || neighbor >= axis.values.length) return [];
    const distance = Math.abs(
      axisValueAsDate(info.dataset, axis, neighbor).getTime() - matched,
    );
    return distance > 0 && Number.isFinite(distance) ? [distance] : [];
  });
  const cadence = neighborDistances.length
    ? Math.min(...neighborDistances)
    : 24 * 60 * 60 * 1000;
  return Math.min(
    24 * 60 * 60 * 1000,
    Math.max(6 * 60 * 60 * 1000, cadence * 1.5),
  );
}

export function comparisonTimeIndex(
  info: StoreInfo,
  variable: VariableConfig,
  axis: AxisConfig,
  anchorDate: Date,
) {
  const match = axisDateMatch(info.dataset, axis, anchorDate);
  const forecast = isForecastSeries(info, variable);
  const tolerance = forecast
    ? forecastInitTolerance(info, axis, match.index)
    : 0;
  const first = Math.min(match.first.getTime(), match.last.getTime());
  const last = Math.max(match.first.getTime(), match.last.getTime());
  const target = anchorDate.getTime();
  const outsideRange = target < first - tolerance || target > last + tolerance;
  if (
    !Number.isFinite(match.date.getTime())
    || outsideRange
    || (forecast && match.distanceMilliseconds > tolerance)
  ) {
    const seriesKind = forecast ? "Forecast archive" : "Dataset";
    throw new Error(
      `${seriesKind} unavailable at ${utcHour(anchorDate)}`
      + ` · available ${utcHour(match.first)}–${utcHour(match.last)}`,
    );
  }
  return match.index;
}
