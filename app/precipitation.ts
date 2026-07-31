import type { DatasetSourceConfig } from "./catalog";
import { commonVariableMatches } from "./common-variables";
import type {
  StoreInfo,
  VariableConfig,
} from "./data/types";
import {
  precipitationRateConverter,
  unitConverter,
} from "./units";

/**
 * Minimum liquid-water accumulation counted as precipitation.
 *
 * Forecast probabilities apply this threshold to each model member and
 * forecast step.
 */
export const PRECIPITATION_EVENT_THRESHOLD_MM = 0.1;
export const PRECIPITATION_RATE_UNIT = "mm/h";
export const PRECIPITATION_RATE_DEFAULT_MAX_MM_H = 5;
/** Minimum normalized precipitation rate rendered on the map. */
export const PRECIPITATION_RATE_VISIBILITY_THRESHOLD_MM_H = 0.03;

export type PrecipitationValueNormalization = {
  kind: "rate";
  toMillimetersPerHour: (value: number) => number;
} | {
  kind: "step" | "cumulative";
  toMillimeters: (value: number) => number;
};

export type MapPrecipitationNormalization =
  PrecipitationValueNormalization & {
    temporalDimension?: string;
  };

function precipitationContext(variable: VariableConfig) {
  return [
    variable.id,
    variable.label,
    variable.standardName ?? "",
  ].join(" ");
}

function isPrecipitationVariable(variable: VariableConfig) {
  return commonVariableMatches([variable]).some((match) => match.key === "tp");
}

export function precipitationValueNormalization(
  variable: VariableConfig,
  accumulation?: DatasetSourceConfig["precipitationAccumulation"],
): PrecipitationValueNormalization | null {
  if (!isPrecipitationVariable(variable)) return null;
  const context = precipitationContext(variable);
  const rateConverter = precipitationRateConverter(variable.unit, context);
  if (rateConverter) {
    return {
      kind: "rate",
      toMillimetersPerHour: (value) => rateConverter(value, 3600),
    };
  }
  const toMillimeters = unitConverter(variable.unit, "mm", context);
  if (!toMillimeters) return null;
  return {
    kind: accumulation === "cumulative" ? "cumulative" : "step",
    toMillimeters,
  };
}

export function mapPrecipitationNormalization(
  info: StoreInfo,
  variable: VariableConfig,
): MapPrecipitationNormalization | null {
  if (variable.derived) return null;
  const normalization = precipitationValueNormalization(
    variable,
    info.source.precipitationAccumulation,
  );
  if (!normalization) return null;
  if (normalization.kind === "rate") return normalization;
  const temporalDimension = variable.dimensions.find(
    (dimension) => info.axes[dimension]?.kind === "timedelta",
  ) ?? variable.dimensions.find(
    (dimension) => info.axes[dimension]?.kind === "time",
  );
  if (
    !temporalDimension
    || (info.axes[temporalDimension]?.values.length ?? 0) < 2
  ) return null;
  return { ...normalization, temporalDimension };
}
