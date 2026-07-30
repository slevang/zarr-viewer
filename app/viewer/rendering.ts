import type { VariableConfig } from "../data/types";
import { PRECIPITATION_EVENT_THRESHOLD_MM } from "../precipitation";
import { unitConverter } from "../units";
import { isHrrrSmokeVariable } from "./smoke";

export const MINIMUM_VISIBLE_PRECIPITATION_MM =
  PRECIPITATION_EVENT_THRESHOLD_MM;
export const MINIMUM_VISIBLE_SMOKE_RANGE_FRACTION = 0.1;

function glslFloat(value: number) {
  const literal = String(value);
  return /[.eE]/.test(literal) ? literal : `${literal}.0`;
}

function variableName(variable: VariableConfig) {
  return [
    variable.id,
    variable.label,
    variable.standardName ?? "",
  ].join(" ").toLowerCase().replace(/[_-]+/g, " ");
}

export function isRainVariable(variable: VariableConfig) {
  const name = variableName(variable);
  const id = variable.id.toLowerCase();
  return (
    id === "tp"
    || id === "pr"
    || /\b(?:precipitation|precip|rain|rainfall|shower|drizzle)\b/.test(name)
  );
}

export function variableFragmentShader(variable: VariableConfig) {
  const smoke = isHrrrSmokeVariable(variable);
  if (!isRainVariable(variable) && !smoke) return undefined;
  const value = variable.id;
  const context = `${variable.id} ${variable.label} ${variable.standardName ?? ""}`;
  const convertMinimum = unitConverter(
    "mm",
    variable.unit,
    context,
  );
  const minimumVisibleValue = convertMinimum
    ? convertMinimum(MINIMUM_VISIBLE_PRECIPITATION_MM)
    : 0;
  const visibilityThreshold = smoke
    ? `(clim.x + (clim.y - clim.x) * ${glslFloat(MINIMUM_VISIBLE_SMOKE_RANGE_FRACTION)})`
    : glslFloat(minimumVisibleValue);
  return `
  if (isnan(${value}_tex) || isnan(${value}) || ${value} <= ${visibilityThreshold}) {
    discard;
  }

  float rescaled = (${value} - clim.x) / (clim.y - clim.x);
  vec4 c = texture(colormap, vec2(rescaled, 0.5));
  fragColor = vec4(c.rgb, opacity);
  fragColor.rgb *= fragColor.a;
`;
}

export function variableRenderingOptions(variable: VariableConfig) {
  const customFrag = variableFragmentShader(variable);
  return customFrag ? { customFrag } : {};
}
