import type { Selector } from "@carbonplan/zarr-layer";

// The viewer is dataset-agnostic; this module adapts the configured demo store.
const DEFAULT_DATA_SOURCE =
  "https://storage.googleapis.com/gcp-public-data-arco-era5/ar/full_37-1h-0p25deg-chunk-1.zarr-v3";

export const DATA_SOURCE = import.meta.env.VITE_ZARR_SOURCE || DEFAULT_DATA_SOURCE;

export const LAYER_OPTIONS = {
  zarrVersion: 2 as const,
  crs: "EPSG:4326",
  bounds: [0, -90, 360, 90] as [number, number, number, number],
  latIsAscending: false,
  spatialDimensions: { lat: "latitude", lon: "longitude" },
};

export const PRELOAD_COORDINATES: [number, number] = [0, 0];
export const RANGE_SAMPLE_COORDINATES = [-72, -48, -24, 0, 24, 48, 72].flatMap((lat) =>
  [0, 45, 90, 135, 180, 225, 270, 315].map((lon) => [lon, lat] as [number, number]),
);

const TIME_ORIGIN_MS = Date.UTC(1900, 0, 1);
const HOUR_MS = 60 * 60 * 1000;
export const DEFAULT_VARIABLE_ID = "2m_temperature";

export const LEVELS = [
  1, 2, 3, 5, 7, 10, 20, 30, 50, 70, 100, 125, 150, 175, 200, 225,
  250, 300, 350, 400, 450, 500, 550, 600, 650, 700, 750, 775, 800, 825,
  850, 875, 900, 925, 950, 975, 1000,
] as const;

export const DEFAULT_LEVEL_INDEX = LEVELS.indexOf(500);

export type VariableConfig = {
  id: string;
  label: string;
  unit: string;
  hasLevel: boolean;
};

type StoreInfo = {
  minTime: number;
  maxTime: number;
  variables: VariableConfig[];
  levelAxis: { label: string; unit: string };
};

type ConsolidatedMetadata = {
  metadata?: Record<string, Record<string, unknown>>;
};

export const FALLBACK_VARIABLE: VariableConfig = {
  id: DEFAULT_VARIABLE_ID,
  label: DEFAULT_VARIABLE_ID,
  unit: "",
  hasLevel: false,
};

export function dateToIndex(date: Date) {
  return Math.round((date.getTime() - TIME_ORIGIN_MS) / HOUR_MS);
}

export function indexToInputDate(index: number) {
  return new Date(TIME_ORIGIN_MS + index * HOUR_MS).toISOString().slice(0, 16);
}

export function selectorFor(index: number, variable: VariableConfig, levelIndex: number): Selector {
  const selector: Selector = { time: { selected: index, type: "index" } };
  if (variable.hasLevel) selector.level = { selected: levelIndex, type: "index" };
  return selector;
}

export function transformRequest(url: string) {
  const parsed = new URL(url);
  const marker = "/gcp-public-data-arco-era5/";
  const markerIndex = parsed.pathname.indexOf(marker);
  if (markerIndex < 0) return { url };
  const objectName = parsed.pathname.slice(markerIndex + marker.length);
  return {
    url: `https://storage.googleapis.com/download/storage/v1/b/gcp-public-data-arco-era5/o/${encodeURIComponent(objectName)}?alt=media`,
  };
}

export function toDataCoordinates(longitude: number, latitude: number): [number, number] {
  return [((longitude % 360) + 360) % 360, latitude];
}

function variablesFromMetadata(consolidated: ConsolidatedMetadata): VariableConfig[] {
  const variables: VariableConfig[] = [];

  for (const [key, attrs] of Object.entries(consolidated.metadata ?? {})) {
    if (!key.endsWith("/.zattrs")) continue;
    const id = key.slice(0, -"/.zattrs".length);
    if (id.includes("/")) continue;

    const dimensions = attrs._ARRAY_DIMENSIONS;
    if (!Array.isArray(dimensions) || !dimensions.every((value) => typeof value === "string")) continue;
    if (!dimensions.includes("time") || !dimensions.includes("latitude") || !dimensions.includes("longitude")) continue;
    if (dimensions.some((dimension) => !["time", "level", "latitude", "longitude"].includes(dimension))) continue;

    const longName = typeof attrs.long_name === "string" ? attrs.long_name.trim() : "";
    variables.push({
      id,
      label: longName || id,
      unit: typeof attrs.units === "string" ? attrs.units : "",
      hasLevel: dimensions.includes("level"),
    });
  }

  return variables.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

async function fetchStoreInfo(): Promise<StoreInfo> {
  const metadataUrl = transformRequest(`${DATA_SOURCE}/.zmetadata`).url;
  const response = await fetch(metadataUrl);
  if (!response.ok) throw new Error(`Store metadata request failed (${response.status})`);

  const consolidated = (await response.json()) as ConsolidatedMetadata;
  const attrs = consolidated.metadata?.[".zattrs"];
  const start = typeof attrs?.valid_time_start === "string" ? attrs.valid_time_start : undefined;
  const stop = typeof attrs?.valid_time_stop_era5t === "string"
    ? attrs.valid_time_stop_era5t
    : typeof attrs?.valid_time_stop === "string"
      ? attrs.valid_time_stop
      : undefined;
  const variables = variablesFromMetadata(consolidated);
  const levelAttrs = consolidated.metadata?.["level/.zattrs"];

  if (!start || !stop) throw new Error("The store did not report its available time range");
  if (!variables.length) throw new Error("The store did not report any compatible spatial variables");

  return {
    minTime: dateToIndex(new Date(`${start}T00:00:00Z`)),
    maxTime: dateToIndex(new Date(`${stop}T23:00:00Z`)),
    variables,
    levelAxis: {
      label: typeof levelAttrs?.long_name === "string" ? levelAttrs.long_name : "level",
      unit: typeof levelAttrs?.units === "string" ? levelAttrs.units : "",
    },
  };
}

let storeInfoPromise: Promise<StoreInfo> | undefined;

export function loadStoreInfo() {
  if (!storeInfoPromise) {
    storeInfoPromise = fetchStoreInfo().catch((error) => {
      storeInfoPromise = undefined;
      throw error;
    });
  }
  return storeInfoPromise;
}
