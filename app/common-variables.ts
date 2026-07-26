import type { VariableConfig } from "./data/types";

export type CommonVariableKey =
  | "t2m"
  | "d2m"
  | "tp"
  | "ssrd"
  | "tcc"
  | "u10"
  | "v10";

export type CommonVariableMatch = {
  key: CommonVariableKey;
  variable: VariableConfig;
};

type CommonVariableDefinition = {
  key: CommonVariableKey;
  aliases: string[];
  fallback: (variable: VariableConfig) => boolean;
};

function normalizedId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function variableContext(variable: VariableConfig) {
  return [variable.id, variable.label, variable.standardName ?? ""]
    .join(" ")
    .toLowerCase()
    .replaceAll("metre", "meter")
    .replace(/[_-]+/g, " ");
}

function isTwoMeterTemperature(variable: VariableConfig) {
  const context = variableContext(variable);
  return /(?:2\s*m|two meter)/.test(context)
    && /(?:temperature|temp)/.test(context)
    && !/(?:dew|maximum|minimum|potential)/.test(context);
}

function isTwoMeterDewPoint(variable: VariableConfig) {
  const context = variableContext(variable);
  return /(?:2\s*m|two meter)/.test(context)
    && /dew\s*point/.test(context);
}

function isTotalPrecipitation(variable: VariableConfig) {
  const context = variableContext(variable);
  const standardName = variable.standardName?.toLowerCase() ?? "";
  return (
    /\btotal precipitation\b/.test(context)
    || standardName === "precipitation_amount"
    || standardName === "precipitation_flux"
  ) && !/(?:frozen|percent|type|probability)/.test(context);
}

function isSurfaceSolarRadiationDownwards(variable: VariableConfig) {
  const context = variableContext(variable);
  const standardName = variable.standardName?.toLowerCase() ?? "";
  return (
    standardName === "surface_downwelling_shortwave_flux_in_air"
    || (
      /(?:downward|downwelling)/.test(context)
      && /short\s*wave|solar radiation/.test(context)
      && /surface/.test(context)
    )
  ) && !/(?:clear sky|direct|diffuse|net|upward|upwelling)/.test(context);
}

function isTotalCloudCover(variable: VariableConfig) {
  return /\btotal cloud cover\b/.test(variableContext(variable));
}

function isTenMeterWindComponent(
  variable: VariableConfig,
  component: "u" | "v",
) {
  const context = variableContext(variable);
  const standardName = variable.standardName?.toLowerCase() ?? "";
  const directionMatches = component === "u"
    ? /(?:\bu component\b|\bwind u\b)/.test(context)
      || ["eastward_wind", "x_wind"].includes(standardName)
    : /(?:\bv component\b|\bwind v\b)/.test(context)
      || ["northward_wind", "y_wind"].includes(standardName);
  return directionMatches
    && /(?:10\s*m|ten meter)/.test(context)
    && !/(?:100\s*m|neutral|gust|maximum)/.test(context);
}

const COMMON_VARIABLES: CommonVariableDefinition[] = [
  {
    key: "t2m",
    aliases: ["t2m", "temperature_2m", "2m_temperature", "air_temperature_2m"],
    fallback: isTwoMeterTemperature,
  },
  {
    key: "d2m",
    aliases: ["d2m", "dew_point_temperature_2m", "2m_dewpoint_temperature"],
    fallback: isTwoMeterDewPoint,
  },
  {
    key: "tp",
    aliases: [
      "tp",
      "total_precipitation",
      "total_precipitation_surface",
      "precipitation_surface",
    ],
    fallback: isTotalPrecipitation,
  },
  {
    key: "ssrd",
    aliases: [
      "ssrd",
      "surface_solar_radiation_downwards",
      "downward_short_wave_radiation_flux_surface",
    ],
    fallback: isSurfaceSolarRadiationDownwards,
  },
  {
    key: "tcc",
    aliases: ["tcc", "total_cloud_cover", "total_cloud_cover_atmosphere"],
    fallback: isTotalCloudCover,
  },
  {
    key: "u10",
    aliases: ["u10", "wind_u_10m", "10m_u_component_of_wind"],
    fallback: (variable) => isTenMeterWindComponent(variable, "u"),
  },
  {
    key: "v10",
    aliases: ["v10", "wind_v_10m", "10m_v_component_of_wind"],
    fallback: (variable) => isTenMeterWindComponent(variable, "v"),
  },
];

function matchDefinition(
  variables: VariableConfig[],
  definition: CommonVariableDefinition,
) {
  for (const alias of definition.aliases) {
    const normalizedAlias = normalizedId(alias);
    const exact = variables.find(
      (variable) => normalizedId(variable.id) === normalizedAlias,
    );
    if (exact) return exact;
  }
  return variables.find(definition.fallback);
}

export function commonVariableMatches(
  variables: VariableConfig[],
): CommonVariableMatch[] {
  return COMMON_VARIABLES.flatMap((definition) => {
    const variable = matchDefinition(variables, definition);
    return variable ? [{ key: definition.key, variable }] : [];
  });
}
