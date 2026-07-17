type NamedVariable = { id: string; label: string };

type Colormap = {
  id: string;
  label: string;
  colors: readonly string[];
};

export const COLORMAPS: readonly Colormap[] = [
  {
    id: "viridis",
    label: "Viridis",
    colors: ["#440154", "#472c7a", "#3b518b", "#2c718e", "#21918c", "#27ad81", "#5cc863", "#aadc32", "#fde725"],
  },
  {
    id: "thermal",
    label: "Thermal",
    colors: ["#17306b", "#275ab0", "#3f8bc2", "#70b9b0", "#b8d89d", "#f2e89a", "#f6ba65", "#ed7650", "#c93c47", "#7d1d3f"],
  },
  {
    id: "coolwarm",
    label: "Cool–warm",
    colors: ["#314a9a", "#5075c8", "#80a6dc", "#b7d0e9", "#e8edf0", "#f2dfd6", "#e9a88f", "#d76a61", "#b93246", "#74152e"],
  },
  {
    id: "balance",
    label: "Balance",
    colors: ["#123c69", "#2166ac", "#67a9cf", "#d1e5f0", "#f7f7f7", "#fddbc7", "#ef8a62", "#b2182b", "#67001f"],
  },
  {
    id: "rain",
    label: "Greens",
    colors: ["#f7fcfd", "#e5f5f9", "#ccece6", "#99d8c9", "#66c2a4", "#41ae76", "#238b45", "#006d2c", "#00441b"],
  },
  {
    id: "ice",
    label: "Ice",
    colors: ["#081d58", "#253494", "#225ea8", "#1d91c0", "#41b6c4", "#7fcdbb", "#c7e9b4", "#edf8b1", "#ffffd9"],
  },
  {
    id: "solar",
    label: "Solar",
    colors: ["#27104e", "#52106c", "#82116e", "#b52f62", "#df5c4d", "#f68d3b", "#fbbc45", "#f8e66a", "#fff8bc"],
  },
  {
    id: "greys",
    label: "Grayscale",
    colors: ["#ffffff", "#ececec", "#d4d4d4", "#b3b3b3", "#8c8c8c", "#636363", "#363636", "#111111"],
  },
];

export const DEFAULT_COLORMAP = COLORMAPS[0];

const DEFAULT_RULES: readonly { id: string; pattern: RegExp }[] = [
  { id: "balance", pattern: /\b(?:u|v)\s+(?:component\s+of\s+wind|wind\s+component)\b|\b(?:eastward|northward)\s+wind\b/ },
  { id: "solar", pattern: /\b(?:solar|sunshine|ultraviolet|uv|short\s+wave|shortwave|toa\s+incident)\b/ },
  { id: "greys", pattern: /\b(?:cloud|clouds|fog)\b/ },
  { id: "ice", pattern: /\b(?:ice|snow|snowfall|snowmelt|frost|frozen|glacier)\b/ },
  { id: "thermal", pattern: /\b(?:temperature|temperatures|dewpoint)\b/ },
];

export function defaultColormap(variable: NamedVariable): Colormap {
  const name = `${variable.id} ${variable.label}`.toLowerCase().replace(/[_-]+/g, " ");
  const match = DEFAULT_RULES.find((rule) => rule.pattern.test(name));
  return COLORMAPS.find((option) => option.id === match?.id) ?? DEFAULT_COLORMAP;
}
