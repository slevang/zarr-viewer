import type { DatasetSourceConfig } from "../catalog";
import type { VariableConfig } from "./types";

const LATITUDE_NAMES = new Set(["latitude", "lat", "y"]);
const LONGITUDE_NAMES = new Set(["longitude", "lon", "x"]);
const INITIALIZATION_NAMES = new Set([
  "init_time",
  "initialization_time",
  "forecast_reference_time",
  "forecast_date",
]);
const ENSEMBLE_NAMES = new Set([
  "ensemble_member",
  "ensemble",
  "member",
  "sample",
  "number",
]);

function normalized(name: string) {
  return name.toLowerCase();
}

export function isLatitudeDimension(
  name: string,
  source?: Pick<DatasetSourceConfig, "spatialDimensions">,
) {
  return LATITUDE_NAMES.has(normalized(name))
    || normalized(source?.spatialDimensions?.lat ?? "") === normalized(name);
}

export function isLongitudeDimension(
  name: string,
  source?: Pick<DatasetSourceConfig, "spatialDimensions">,
) {
  return LONGITUDE_NAMES.has(normalized(name))
    || normalized(source?.spatialDimensions?.lon ?? "") === normalized(name);
}

export function isSpatialDimension(
  name: string,
  source?: Pick<DatasetSourceConfig, "spatialDimensions">,
) {
  return isLatitudeDimension(name, source)
    || isLongitudeDimension(name, source);
}

export function hasSpatialDimensions(
  dimensions: string[],
  source?: Pick<DatasetSourceConfig, "spatialDimensions">,
) {
  return dimensions.some((name) => isLatitudeDimension(name, source))
    && dimensions.some((name) => isLongitudeDimension(name, source));
}

export function spatialDimension(
  variable: VariableConfig,
  source: Pick<DatasetSourceConfig, "spatialDimensions">,
  axis: "lat" | "lon",
) {
  const configured = source.spatialDimensions?.[axis];
  if (configured && variable.dimensions.includes(configured)) return configured;
  const predicate = axis === "lat"
    ? isLatitudeDimension
    : isLongitudeDimension;
  return variable.dimensions.find((name) => predicate(name, source));
}

export function isInitializationDimension(name: string) {
  return INITIALIZATION_NAMES.has(normalized(name));
}

export function isValidTimeDimension(name: string) {
  return normalized(name).includes("valid");
}

export function isEnsembleDimension(name: string) {
  return ENSEMBLE_NAMES.has(normalized(name));
}
