import type { VariableConfig } from "../data/types";

export const HRRR_SMOKE_VARIABLE_IDS = [
  "mass_density_8m",
  "column_integrated_mass_density_atmosphere",
  "aerosol_optical_thickness_atmosphere",
] as const;

const HRRR_SMOKE_VARIABLE_ID_SET = new Set<string>(HRRR_SMOKE_VARIABLE_IDS);

export function isHrrrSmokeVariable(variable: Pick<VariableConfig, "id">) {
  return HRRR_SMOKE_VARIABLE_ID_SET.has(variable.id);
}

export function hrrrSmokeVariables(
  datasetId: string | undefined,
  variables: readonly VariableConfig[],
) {
  if (datasetId !== "noaa-hrrr-forecast-48-hour") return [];
  return HRRR_SMOKE_VARIABLE_IDS.flatMap((id) => {
    const variable = variables.find((candidate) => candidate.id === id);
    return variable ? [variable] : [];
  });
}
