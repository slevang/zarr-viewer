import { commonVariableMatches } from "../app/common-variables";
import {
  datasetChunkingLabel,
  getDataset,
} from "../app/catalog";
import type { VariableConfig } from "../app/dataset";

function variable(
  id: string,
  label = id,
  standardName?: string,
): VariableConfig {
  return {
    id,
    label,
    standardName,
    unit: "",
    dimensions: [],
  };
}

function assertMatches(
  name: string,
  variables: VariableConfig[],
  expected: string[],
) {
  const actual = commonVariableMatches(variables).map(
    ({ key, variable: match }) => `${key}:${match.id}`,
  );
  if (actual.join(",") !== expected.join(",")) {
    throw new Error(`${name}: expected ${expected.join(",")}; received ${actual.join(",")}`);
  }
}

assertMatches("Google ERA5", [
  variable("10m_v_component_of_wind"),
  variable("2m_dewpoint_temperature"),
  variable("total_precipitation"),
  variable("surface_solar_radiation_downwards"),
  variable("2m_temperature"),
  variable("total_cloud_cover"),
  variable("10m_u_component_of_wind"),
], [
  "t2m:2m_temperature",
  "d2m:2m_dewpoint_temperature",
  "tp:total_precipitation",
  "ssrd:surface_solar_radiation_downwards",
  "tcc:total_cloud_cover",
  "u10:10m_u_component_of_wind",
  "v10:10m_v_component_of_wind",
]);

assertMatches("dynamical.org", [
  variable("wind_v_10m"),
  variable("precipitation_surface", "Precipitation rate", "precipitation_flux"),
  variable("temperature_2m"),
  variable("downward_short_wave_radiation_flux_surface"),
  variable("total_cloud_cover_atmosphere"),
  variable("wind_u_10m"),
], [
  "t2m:temperature_2m",
  "tp:precipitation_surface",
  "ssrd:downward_short_wave_radiation_flux_surface",
  "tcc:total_cloud_cover_atmosphere",
  "u10:wind_u_10m",
  "v10:wind_v_10m",
]);

assertMatches("Earthmover ERA5", [
  variable("v10"),
  variable("tcc"),
  variable("tp"),
  variable("d2m"),
  variable("u10"),
  variable("ssrd"),
  variable("t2m"),
], [
  "t2m:t2m",
  "d2m:d2m",
  "tp:tp",
  "ssrd:ssrd",
  "tcc:tcc",
  "u10:u10",
  "v10:v10",
]);

assertMatches("Salient GemAI v3", [
  variable("2m_temperature", "2 metre temperature"),
  variable(
    "mean_2m_dewpoint_temperature",
    "Mean 2 metre dewpoint temperature",
  ),
  variable(
    "mean_total_precipitation_rate",
    "Mean total precipitation rate",
    "precipitation_flux",
  ),
  variable(
    "mean_surface_downward_short_wave_radiation_flux",
    "Mean surface downward short wave radiation flux",
  ),
  variable("mean_total_cloud_cover", "Mean total cloud cover"),
], [
  "t2m:2m_temperature",
  "d2m:mean_2m_dewpoint_temperature",
  "tp:mean_total_precipitation_rate",
  "ssrd:mean_surface_downward_short_wave_radiation_flux",
  "tcc:mean_total_cloud_cover",
]);

assertMatches("No false solar aggregate", [
  variable("downward_diffuse_short_wave_radiation_flux_surface"),
  variable("downward_direct_short_wave_radiation_flux_surface"),
], []);

const expectedChunking = new Map([
  ["weatherzarr-ecmwf-ifs", "Dual-chunked"],
  ["noaa-hrrr-forecast-48-hour", "Dual-chunked"],
  ["earthmover-era5", "Dual-chunked"],
  ["google-arco-era5", "Spatially-chunked"],
  ["google-weathernext-2", "Spatially-chunked"],
  ["noaa-gfs-forecast", "Timeseries-chunked"],
]);
for (const [datasetId, expected] of expectedChunking) {
  const actual = datasetChunkingLabel(getDataset(datasetId));
  if (actual !== expected) {
    throw new Error(`${datasetId}: expected ${expected}; received ${actual}`);
  }
}

console.log("Common variable checks passed");
