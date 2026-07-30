import {
  DATASETS,
  DEFAULT_DATASET_ID,
  getDataset,
  hasMapSource,
} from "../catalog";

const DATASET_PARAMETER = "dataset";
const UNIT_PREFERENCES_STORAGE_KEY = "zarr-viewer:unit-preferences";
const MAP_DATASETS = DATASETS.filter(hasMapSource);

export function hasRequestedDataset() {
  if (typeof window === "undefined") return false;
  const requested = new URL(window.location.href).searchParams.get(
    DATASET_PARAMETER,
  );
  return Boolean(
    requested && MAP_DATASETS.some((candidate) => candidate.id === requested),
  );
}

export function initialDatasetId() {
  if (typeof window === "undefined") return getDataset(DEFAULT_DATASET_ID).id;
  const requested = new URL(window.location.href).searchParams.get(
    DATASET_PARAMETER,
  );
  return hasRequestedDataset()
    ? requested!
    : getDataset(DEFAULT_DATASET_ID).id;
}

export type InitialViewerLocation = {
  mode: "series" | "meteogram";
  screen: "map" | "forecast";
  station?: string;
  latitude?: number;
  longitude?: number;
  centerLatitude?: number;
  centerLongitude?: number;
  zoom?: number;
  variableId?: string;
  axisValues: Record<string, string>;
  colormapId?: string;
  opacity?: number;
  displayUnit?: string;
  displayRange?: [number, number];
  projection?: "globe" | "mercator";
};

export type ViewerUrlState = {
  datasetId: string;
  mode: "series" | "meteogram";
  screen?: "map" | "forecast";
  station?: string;
  latitude?: number;
  longitude?: number;
  centerLatitude?: number;
  centerLongitude?: number;
  zoom?: number;
  variableId?: string;
  axisValues?: Record<string, string>;
  colormapId?: string;
  opacity?: number;
  displayUnit?: string;
  displayRange?: [number, number];
  projection?: "globe" | "mercator";
};

export function initialViewerLocation(): InitialViewerLocation {
  if (typeof window === "undefined") {
    return { mode: "series", screen: "map", axisValues: {} };
  }
  return viewerLocationFromUrl(window.location.href);
}

export function viewerLocationFromUrl(currentUrl: string): InitialViewerLocation {
  const parameters = new URL(currentUrl).searchParams;
  const station = parameters.get("station")?.trim().toUpperCase() || undefined;
  const latitudeParameter = parameters.get("lat");
  const longitudeParameter = parameters.get("lon");
  const centerLatitudeParameter = parameters.get("centerLat");
  const centerLongitudeParameter = parameters.get("centerLon");
  const zoomParameter = parameters.get("zoom");
  const latitude = latitudeParameter === null ? NaN : Number(latitudeParameter);
  const longitude = longitudeParameter === null ? NaN : Number(longitudeParameter);
  const centerLatitude = centerLatitudeParameter === null
    ? NaN
    : Number(centerLatitudeParameter);
  const centerLongitude = centerLongitudeParameter === null
    ? NaN
    : Number(centerLongitudeParameter);
  const zoom = zoomParameter === null ? NaN : Number(zoomParameter);
  const hasCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude);
  const requestedView = parameters.get("view");
  const requestedScreen = parameters.get("screen");
  const opacityParameter = parameters.get("opacity");
  const rangeMinimumParameter = parameters.get("min");
  const rangeMaximumParameter = parameters.get("max");
  const opacity = opacityParameter === null ? NaN : Number(opacityParameter);
  const rangeMinimum = rangeMinimumParameter === null
    ? NaN
    : Number(rangeMinimumParameter);
  const rangeMaximum = rangeMaximumParameter === null
    ? NaN
    : Number(rangeMaximumParameter);
  const projection = parameters.get("projection");
  const mode = requestedView === "series"
      ? "series"
      : requestedView === "meteogram" || station || hasCoordinates
        ? "meteogram"
        : "series";
  return {
    mode,
    screen: requestedScreen === "map" || requestedScreen === "forecast"
      ? requestedScreen
      : mode === "meteogram"
        ? "forecast"
        : "map",
    station,
    latitude: Number.isFinite(latitude) ? latitude : undefined,
    longitude: Number.isFinite(longitude) ? longitude : undefined,
    centerLatitude: Number.isFinite(centerLatitude)
      ? Math.max(-90, Math.min(90, centerLatitude))
      : undefined,
    centerLongitude: Number.isFinite(centerLongitude)
      ? centerLongitude >= -180 && centerLongitude <= 180
        ? centerLongitude
        : ((centerLongitude + 540) % 360) - 180
      : undefined,
    zoom: Number.isFinite(zoom)
      ? Math.max(0.25, Math.min(8, zoom))
      : undefined,
    variableId: parameters.get("variable") || undefined,
    axisValues: Object.fromEntries(
      Array.from(parameters.entries()).flatMap(([key, value]) =>
        key.startsWith("sel.")
          ? [[key.slice(4), value]]
          : []
      ),
    ),
    colormapId: parameters.get("colormap") || undefined,
    opacity: Number.isFinite(opacity)
      ? Math.max(0.2, Math.min(1, opacity))
      : undefined,
    displayUnit: parameters.get("unit") || undefined,
    displayRange: Number.isFinite(rangeMinimum)
      && Number.isFinite(rangeMaximum)
      && rangeMinimum < rangeMaximum
      ? [rangeMinimum, rangeMaximum]
      : undefined,
    projection: projection === "mercator" || projection === "globe"
      ? projection
      : undefined,
  };
}

export function baseViewerUrl(currentUrl: string) {
  const url = new URL(currentUrl);
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function viewerShareUrl(currentUrl: string, {
  datasetId,
  mode,
  screen,
  station,
  latitude,
  longitude,
  centerLatitude,
  centerLongitude,
  zoom,
  variableId,
  axisValues,
  colormapId,
  opacity,
  displayUnit,
  displayRange,
  projection,
}: ViewerUrlState) {
  const url = new URL(baseViewerUrl(currentUrl));
  url.searchParams.set(DATASET_PARAMETER, datasetId);
  const hasLocation = Boolean(station)
    || (Number.isFinite(latitude) && Number.isFinite(longitude));
  if (mode === "meteogram") url.searchParams.set("view", "meteogram");
  else if (hasLocation) url.searchParams.set("view", "series");
  else url.searchParams.delete("view");
  if (screen) url.searchParams.set("screen", screen);
  else url.searchParams.delete("screen");
  if (
    Number.isFinite(centerLatitude)
    && Number.isFinite(centerLongitude)
  ) {
    url.searchParams.set(
      "centerLat",
      Number(centerLatitude).toFixed(5),
    );
    url.searchParams.set(
      "centerLon",
      Number(centerLongitude).toFixed(5),
    );
  } else {
    url.searchParams.delete("centerLat");
    url.searchParams.delete("centerLon");
  }
  if (Number.isFinite(zoom)) {
    url.searchParams.set("zoom", Number(zoom).toFixed(3));
  } else {
    url.searchParams.delete("zoom");
  }
  if (station) {
    url.searchParams.set("station", station);
    url.searchParams.delete("lat");
    url.searchParams.delete("lon");
  } else if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    url.searchParams.delete("station");
    url.searchParams.set("lat", Number(latitude).toFixed(4));
    url.searchParams.set("lon", Number(longitude).toFixed(4));
  } else {
    url.searchParams.delete("station");
    url.searchParams.delete("lat");
    url.searchParams.delete("lon");
  }
  if (variableId) url.searchParams.set("variable", variableId);
  else url.searchParams.delete("variable");
  if (axisValues) {
    for (const key of Array.from(url.searchParams.keys())) {
      if (key.startsWith("sel.")) url.searchParams.delete(key);
    }
    for (const [axis, value] of Object.entries(axisValues)) {
      url.searchParams.set(`sel.${axis}`, value);
    }
  }
  if (colormapId) url.searchParams.set("colormap", colormapId);
  else url.searchParams.delete("colormap");
  if (opacity !== undefined) {
    url.searchParams.set("opacity", opacity.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""));
  } else {
    url.searchParams.delete("opacity");
  }
  if (displayUnit) url.searchParams.set("unit", displayUnit);
  else url.searchParams.delete("unit");
  if (displayRange) {
    url.searchParams.set("min", String(displayRange[0]));
    url.searchParams.set("max", String(displayRange[1]));
  } else {
    url.searchParams.delete("min");
    url.searchParams.delete("max");
  }
  if (projection) url.searchParams.set("projection", projection);
  else url.searchParams.delete("projection");
  return url.toString();
}

export function storedUnitPreferences() {
  if (typeof window === "undefined") return {};
  try {
    const value = window.localStorage.getItem(UNIT_PREFERENCES_STORAGE_KEY);
    if (!value) return {};
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

export function storeUnitPreferences(preferences: Record<string, string>) {
  try {
    window.localStorage.setItem(
      UNIT_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences),
    );
  } catch {
    // Unit selection still works for the current session without storage.
  }
}
