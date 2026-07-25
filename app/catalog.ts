export type DatasetSupport = "ready" | "experimental" | "blocked";
export type DatasetSourceRole = "map" | "series";

export type DatasetSourceConfig = {
  id: string;
  kind: "zarr" | "icechunk";
  url: string;
  s3Url?: string;
  group?: string;
  zarrVersion: 2 | 3;
  spatialDimensions?: { lat: string; lon: string };
  bounds?: [number, number, number, number];
  crs?: string;
  proj4?: string;
  latIsAscending?: boolean;
};

export type DatasetConfig = {
  id: string;
  label: string;
  provider: "Google" | "dynamical.org" | "Earthmover";
  description: string;
  sources: {
    map?: DatasetSourceConfig;
    series?: DatasetSourceConfig;
  };
  support: DatasetSupport;
  supportNote?: string;
  defaultVariable?: string;
};

function sharedSource(source: DatasetSourceConfig) {
  return { map: source, series: source };
}

const HRRR_GRID = {
  spatialDimensions: { lat: "y", lon: "x" },
  bounds: [-2699020.1425, -1588806.1526, 2697979.8575, 1588193.8474],
  crs: "HRRR Lambert conformal",
  proj4: "+proj=lcc +lat_1=38.5 +lat_2=38.5 +lat_0=38.5 +lon_0=-97.5 +x_0=0 +y_0=0 +R=6371229 +units=m +no_defs",
  latIsAscending: false,
} satisfies Pick<
  DatasetSourceConfig,
  "spatialDimensions" | "bounds" | "crs" | "proj4" | "latIsAscending"
>;

const DYNAMICAL_DATASETS: DatasetConfig[] = [
  {
    id: "noaa-gfs-analysis",
    label: "NOAA GFS analysis",
    provider: "dynamical.org",
    description: "Global, 0.25°, hourly analysis; time-optimized.",
    sources: {
      map: {
        id: "noaa-gfs-analysis",
        kind: "icechunk",
        url: "https://dynamical-noaa-gfs.s3.us-west-2.amazonaws.com/noaa-gfs-analysis/v0.1.0.icechunk",
        s3Url: "s3://dynamical-noaa-gfs/noaa-gfs-analysis/v0.1.0.icechunk/",
        zarrVersion: 3,
      },
    },
    support: "ready",
    defaultVariable: "temperature_2m",
  },
  {
    id: "noaa-gfs-forecast",
    label: "NOAA GFS forecast",
    provider: "dynamical.org",
    description: "Global, 0.25°, 16-day deterministic forecast.",
    sources: sharedSource({
      id: "noaa-gfs-forecast",
      kind: "icechunk",
      url: "https://dynamical-noaa-gfs.s3.us-west-2.amazonaws.com/noaa-gfs-forecast/v0.2.7.icechunk",
      s3Url: "s3://dynamical-noaa-gfs/noaa-gfs-forecast/v0.2.7.icechunk/",
      zarrVersion: 3,
    }),
    support: "ready",
    defaultVariable: "temperature_2m",
  },
  {
    id: "noaa-gefs-forecast-35-day",
    label: "NOAA GEFS forecast · 35 day",
    provider: "dynamical.org",
    description: "Global ensemble forecast through 35 days.",
    sources: sharedSource({
      id: "noaa-gefs-forecast-35-day",
      kind: "icechunk",
      url: "https://dynamical-noaa-gefs.s3.us-west-2.amazonaws.com/noaa-gefs-forecast-35-day/v0.2.0.icechunk",
      s3Url: "s3://dynamical-noaa-gefs/noaa-gefs-forecast-35-day/v0.2.0.icechunk/",
      zarrVersion: 3,
    }),
    support: "ready",
    defaultVariable: "temperature_2m",
  },
  {
    id: "noaa-gefs-analysis",
    label: "NOAA GEFS analysis",
    provider: "dynamical.org",
    description: "Global, 0.25°, three-hourly ensemble analysis.",
    sources: {
      map: {
        id: "noaa-gefs-analysis",
        kind: "icechunk",
        url: "https://dynamical-noaa-gefs.s3.us-west-2.amazonaws.com/noaa-gefs-analysis/v0.1.2.icechunk",
        s3Url: "s3://dynamical-noaa-gefs/noaa-gefs-analysis/v0.1.2.icechunk/",
        zarrVersion: 3,
      },
    },
    support: "ready",
    defaultVariable: "temperature_2m",
  },
  {
    id: "noaa-hrrr-forecast-48-hour",
    label: "NOAA HRRR forecast",
    provider: "dynamical.org",
    description: "CONUS, 3 km forecast with role-optimized map and point-series stores.",
    sources: {
      map: {
        id: "noaa-hrrr-forecast-48-hour-virtual",
        kind: "icechunk",
        url: "https://dynamical-noaa-hrrr.s3.us-west-2.amazonaws.com/noaa-hrrr-forecast-48-hour-virtual/v0.5.0.icechunk",
        s3Url: "s3://dynamical-noaa-hrrr/noaa-hrrr-forecast-48-hour-virtual/v0.5.0.icechunk/",
        zarrVersion: 3,
        ...HRRR_GRID,
      },
      series: {
        id: "noaa-hrrr-forecast-48-hour",
        kind: "icechunk",
        url: "https://dynamical-noaa-hrrr.s3.us-west-2.amazonaws.com/noaa-hrrr-forecast-48-hour/v0.1.0.icechunk",
        s3Url: "s3://dynamical-noaa-hrrr/noaa-hrrr-forecast-48-hour/v0.1.0.icechunk/",
        zarrVersion: 3,
        ...HRRR_GRID,
      },
    },
    support: "experimental",
    supportNote: "Map frames use the GRIB-backed store; point forecasts use the time-optimized store.",
    defaultVariable: "temperature_2m",
  },
  {
    id: "noaa-hrrr-analysis",
    label: "NOAA HRRR analysis",
    provider: "dynamical.org",
    description: "CONUS, 3 km, hourly analysis.",
    sources: {
      map: {
        id: "noaa-hrrr-analysis",
        kind: "icechunk",
        url: "https://dynamical-noaa-hrrr.s3.us-west-2.amazonaws.com/noaa-hrrr-analysis/v0.2.0.icechunk",
        s3Url: "s3://dynamical-noaa-hrrr/noaa-hrrr-analysis/v0.2.0.icechunk/",
        zarrVersion: 3,
        ...HRRR_GRID,
      },
    },
    support: "experimental",
    supportNote: "Uses the available time-oriented store for maps until a spatial store exists.",
    defaultVariable: "temperature_2m",
  },
  {
    id: "ecmwf-aifs-single-forecast",
    label: "ECMWF AIFS Single forecast",
    provider: "dynamical.org",
    description: "Global deterministic AI forecast through 15 days.",
    sources: sharedSource({
      id: "ecmwf-aifs-single-forecast",
      kind: "icechunk",
      url: "https://dynamical-ecmwf-aifs-single.s3.us-west-2.amazonaws.com/ecmwf-aifs-single-forecast/v0.1.0.icechunk",
      s3Url: "s3://dynamical-ecmwf-aifs-single/ecmwf-aifs-single-forecast/v0.1.0.icechunk/",
      zarrVersion: 3,
    }),
    support: "ready",
    defaultVariable: "temperature_2m",
  },
  {
    id: "ecmwf-aifs-ens-forecast",
    label: "ECMWF AIFS ENS forecast",
    provider: "dynamical.org",
    description: "Global AI ensemble forecast through 15 days.",
    sources: sharedSource({
      id: "ecmwf-aifs-ens-forecast",
      kind: "icechunk",
      url: "https://dynamical-ecmwf-aifs-ens.s3.us-west-2.amazonaws.com/ecmwf-aifs-ens-forecast/v0.1.0.icechunk",
      s3Url: "s3://dynamical-ecmwf-aifs-ens/ecmwf-aifs-ens-forecast/v0.1.0.icechunk/",
      zarrVersion: 3,
    }),
    support: "ready",
    defaultVariable: "temperature_2m",
  },
  {
    id: "ecmwf-ifs-ens-forecast-15-day-0-25-degree",
    label: "ECMWF IFS ENS forecast",
    provider: "dynamical.org",
    description: "Global, 0.25° ensemble forecast through 15 days.",
    sources: sharedSource({
      id: "ecmwf-ifs-ens-forecast-15-day-0-25-degree",
      kind: "icechunk",
      url: "https://dynamical-ecmwf-ifs-ens.s3.us-west-2.amazonaws.com/ecmwf-ifs-ens-forecast-15-day-0-25-degree/v0.1.0.icechunk",
      s3Url: "s3://dynamical-ecmwf-ifs-ens/ecmwf-ifs-ens-forecast-15-day-0-25-degree/v0.1.0.icechunk/",
      zarrVersion: 3,
    }),
    support: "ready",
    defaultVariable: "temperature_2m",
  },
  {
    id: "dwd-icon-eu-forecast-5-day",
    label: "DWD ICON-EU forecast",
    provider: "dynamical.org",
    description: "European forecast, 0.0625°, through five days.",
    sources: sharedSource({
      id: "dwd-icon-eu-forecast-5-day",
      kind: "icechunk",
      url: "https://dynamical-dwd-icon-eu.s3.us-west-2.amazonaws.com/dwd-icon-eu-forecast-5-day/v0.2.0.icechunk",
      s3Url: "s3://dynamical-dwd-icon-eu/dwd-icon-eu-forecast-5-day/v0.2.0.icechunk/",
      zarrVersion: 3,
    }),
    support: "experimental",
    supportNote: "Regional projected-grid rendering is experimental.",
    defaultVariable: "temperature_2m",
  },
];

export const DATASETS: DatasetConfig[] = [
  {
    id: "google-arco-era5",
    label: "ECMWF ERA5 reanalysis",
    provider: "Google",
    description: "Global hourly ERA5, spatially chunked for map reads.",
    sources: {
      map: {
        id: "google-arco-era5-spatial",
        kind: "zarr",
        url: "https://storage.googleapis.com/gcp-public-data-arco-era5/ar/full_37-1h-0p25deg-chunk-1.zarr-v3",
        zarrVersion: 2,
        spatialDimensions: { lat: "latitude", lon: "longitude" },
        bounds: [0, -90, 360, 90],
        crs: "EPSG:4326",
        latIsAscending: false,
      },
    },
    support: "ready",
    defaultVariable: "2m_temperature",
  },
  ...DYNAMICAL_DATASETS,
  {
    id: "earthmover-era5",
    label: "ECMWF ERA5 reanalysis",
    provider: "Earthmover",
    description: "Open ERA5 single-level map and temporal layouts, 1940–2025.",
    sources: {
      map: {
        id: "earthmover-era5-single-spatial",
        kind: "icechunk",
        url: "https://earthmover-icechunk-era5.s3.us-east-1.amazonaws.com/icechunkV2",
        s3Url: "s3://earthmover-icechunk-era5/icechunkV2",
        group: "single/spatial",
        zarrVersion: 3,
      },
      series: {
        id: "earthmover-era5-single-temporal",
        kind: "icechunk",
        url: "https://earthmover-icechunk-era5.s3.us-east-1.amazonaws.com/icechunkV2",
        s3Url: "s3://earthmover-icechunk-era5/icechunkV2",
        group: "single/temporal",
        zarrVersion: 3,
      },
    },
    support: "experimental",
    supportNote: "Uses the read-only PCodec WASM decoder.",
    defaultVariable: "t2m",
  },
];

const DATASET_ALIASES: Record<string, string> = {
  "noaa-hrrr-forecast-48-hour-virtual": "noaa-hrrr-forecast-48-hour",
  "earthmover-era5-single-spatial": "earthmover-era5",
};

export const DEFAULT_DATASET_ID =
  import.meta.env?.VITE_DATASET_ID || "google-arco-era5";

export function getDataset(id: string) {
  const resolvedId = DATASET_ALIASES[id] ?? id;
  return DATASETS.find((dataset) => dataset.id === resolvedId) ?? DATASETS[0];
}

export function getDatasetSource(
  dataset: DatasetConfig,
  role: DatasetSourceRole,
) {
  return dataset.sources[role];
}

export function hasMapSource(dataset: DatasetConfig) {
  return Boolean(dataset.sources.map);
}

export function hasSeriesSource(dataset: DatasetConfig) {
  return Boolean(dataset.sources.series);
}
