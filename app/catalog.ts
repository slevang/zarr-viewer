export type DatasetSupport = "ready" | "experimental" | "blocked";
export type DatasetSourceRole = "map" | "series";
export type DatasetCategory = "forecast" | "analysis";

export type DatasetSourceConfig = {
  id: string;
  kind:
    | "zarr"
    | "icechunk"
    | "weatherzarr"
    | "weathernext"
    | "google-arco"
    | "ecmwf-arco";
  url: string;
  s3Url?: string;
  group?: string;
  zarrVersion: 2 | 3;
  auth?: "google" | "cds-api-key";
  spatialDimensions?: { lat: string; lon: string };
  bounds?: [number, number, number, number];
  crs?: string;
  proj4?: string;
  latIsAscending?: boolean;
  layout?: "spatial" | "timeseries";
  directChunkReads?: boolean;
  precipitationAccumulation?: "cumulative";
  geographicBounds?: [west: number, south: number, east: number, north: number];
  meteogram?: {
    kind: "regional" | "global-ensemble" | "global-control";
    comparisonPriority?: number;
    firstLeadHour?: number;
  };
};

export type DatasetConfig = {
  id: string;
  label: string;
  provider: string;
  category: DatasetCategory;
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
  geographicBounds: [-125, 21, -66, 50] as [
    west: number,
    south: number,
    east: number,
    north: number,
  ],
} satisfies Pick<
  DatasetSourceConfig,
  "spatialDimensions" | "bounds" | "crs" | "proj4" | "latIsAscending"
  | "geographicBounds"
>;

const DYNAMICAL_DATASETS: DatasetConfig[] = [
  {
    id: "noaa-gfs-analysis",
    label: "NOAA GFS analysis",
    provider: "dynamical.org",
    category: "analysis",
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
    defaultVariable: "precipitation_surface",
  },
  {
    id: "noaa-gfs-forecast",
    label: "NOAA GFS forecast",
    provider: "dynamical.org",
    category: "forecast",
    description: "Global, 0.25°, 16-day deterministic forecast.",
    sources: sharedSource({
      id: "noaa-gfs-forecast",
      kind: "icechunk",
      url: "https://dynamical-noaa-gfs.s3.us-west-2.amazonaws.com/noaa-gfs-forecast/v0.2.7.icechunk",
      s3Url: "s3://dynamical-noaa-gfs/noaa-gfs-forecast/v0.2.7.icechunk/",
      zarrVersion: 3,
    }),
    support: "ready",
    defaultVariable: "precipitation_surface",
  },
  {
    id: "noaa-gefs-forecast-35-day",
    label: "NOAA GEFS forecast",
    provider: "dynamical.org",
    category: "forecast",
    description: "Global ensemble forecast through 35 days.",
    sources: sharedSource({
      id: "noaa-gefs-forecast-35-day",
      kind: "icechunk",
      url: "https://dynamical-noaa-gefs.s3.us-west-2.amazonaws.com/noaa-gefs-forecast-35-day/v0.2.0.icechunk",
      s3Url: "s3://dynamical-noaa-gefs/noaa-gefs-forecast-35-day/v0.2.0.icechunk/",
      zarrVersion: 3,
    }),
    support: "ready",
    defaultVariable: "precipitation_surface",
  },
  {
    id: "noaa-gefs-analysis",
    label: "NOAA GEFS analysis",
    provider: "dynamical.org",
    category: "analysis",
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
    defaultVariable: "precipitation_surface",
  },
  {
    id: "noaa-hrrr-forecast-48-hour",
    label: "NOAA HRRR forecast",
    provider: "dynamical.org",
    category: "forecast",
    description: "CONUS, 3 km forecast with role-optimized map and point-series stores.",
    sources: {
      map: {
        id: "noaa-hrrr-forecast-48-hour-virtual",
        kind: "icechunk",
        url: "https://dynamical-noaa-hrrr.s3.us-west-2.amazonaws.com/noaa-hrrr-forecast-48-hour-virtual/v0.5.0.icechunk",
        s3Url: "s3://dynamical-noaa-hrrr/noaa-hrrr-forecast-48-hour-virtual/v0.5.0.icechunk/",
        zarrVersion: 3,
        layout: "spatial",
        meteogram: {
          kind: "regional",
          firstLeadHour: 1,
        },
        ...HRRR_GRID,
      },
      series: {
        id: "noaa-hrrr-forecast-48-hour",
        kind: "icechunk",
        url: "https://dynamical-noaa-hrrr.s3.us-west-2.amazonaws.com/noaa-hrrr-forecast-48-hour/v0.1.0.icechunk",
        s3Url: "s3://dynamical-noaa-hrrr/noaa-hrrr-forecast-48-hour/v0.1.0.icechunk/",
        zarrVersion: 3,
        meteogram: {
          kind: "regional",
          comparisonPriority: 10,
          firstLeadHour: 1,
        },
        ...HRRR_GRID,
      },
    },
    support: "experimental",
    supportNote: "Map frames use the GRIB-backed store; point forecasts use the time-optimized store.",
    defaultVariable: "total_precipitation_surface",
  },
  {
    id: "noaa-hrrr-analysis",
    label: "NOAA HRRR analysis",
    provider: "dynamical.org",
    category: "analysis",
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
    defaultVariable: "precipitation_surface",
  },
  {
    id: "ecmwf-aifs-single-forecast",
    label: "ECMWF AIFS Single forecast",
    provider: "dynamical.org",
    category: "forecast",
    description: "Global deterministic AI forecast through 15 days.",
    sources: sharedSource({
      id: "ecmwf-aifs-single-forecast",
      kind: "icechunk",
      url: "https://dynamical-ecmwf-aifs-single.s3.us-west-2.amazonaws.com/ecmwf-aifs-single-forecast/v0.1.0.icechunk",
      s3Url: "s3://dynamical-ecmwf-aifs-single/ecmwf-aifs-single-forecast/v0.1.0.icechunk/",
      zarrVersion: 3,
    }),
    support: "ready",
    defaultVariable: "precipitation_surface",
  },
  {
    id: "ecmwf-aifs-ens-forecast",
    label: "ECMWF AIFS ENS forecast",
    provider: "dynamical.org",
    category: "forecast",
    description: "Global AI ensemble forecast through 15 days.",
    sources: sharedSource({
      id: "ecmwf-aifs-ens-forecast",
      kind: "icechunk",
      url: "https://dynamical-ecmwf-aifs-ens.s3.us-west-2.amazonaws.com/ecmwf-aifs-ens-forecast/v0.1.0.icechunk",
      s3Url: "s3://dynamical-ecmwf-aifs-ens/ecmwf-aifs-ens-forecast/v0.1.0.icechunk/",
      zarrVersion: 3,
    }),
    support: "ready",
    defaultVariable: "precipitation_surface",
  },
  {
    id: "ecmwf-ifs-ens-forecast-15-day-0-25-degree",
    label: "ECMWF IFS ENS forecast",
    provider: "dynamical.org",
    category: "forecast",
    description: "Global, 0.25° ensemble forecast through 15 days.",
    sources: sharedSource({
      id: "ecmwf-ifs-ens-forecast-15-day-0-25-degree",
      kind: "icechunk",
      url: "https://dynamical-ecmwf-ifs-ens.s3.us-west-2.amazonaws.com/ecmwf-ifs-ens-forecast-15-day-0-25-degree/v0.1.0.icechunk",
      s3Url: "s3://dynamical-ecmwf-ifs-ens/ecmwf-ifs-ens-forecast-15-day-0-25-degree/v0.1.0.icechunk/",
      zarrVersion: 3,
      geographicBounds: [-180, -90, 180, 90],
      meteogram: {
        kind: "global-ensemble",
        comparisonPriority: 20,
        firstLeadHour: 3,
      },
    }),
    support: "ready",
    defaultVariable: "precipitation_surface",
  },
  {
    id: "dwd-icon-eu-forecast-5-day",
    label: "DWD ICON-EU forecast",
    provider: "dynamical.org",
    category: "forecast",
    description: "European forecast, 0.0625°, through five days.",
    sources: sharedSource({
      id: "dwd-icon-eu-forecast-5-day",
      kind: "icechunk",
      url: "https://dynamical-dwd-icon-eu.s3.us-west-2.amazonaws.com/dwd-icon-eu-forecast-5-day/v0.2.0.icechunk",
      s3Url: "s3://dynamical-dwd-icon-eu/dwd-icon-eu-forecast-5-day/v0.2.0.icechunk/",
      zarrVersion: 3,
      geographicBounds: [-25, 29, 45, 72],
      meteogram: {
        kind: "regional",
        comparisonPriority: 11,
        firstLeadHour: 1,
      },
    }),
    support: "experimental",
    supportNote: "Regional projected-grid rendering is experimental.",
    defaultVariable: "precipitation_surface",
  },
];

export const DATASETS: DatasetConfig[] = [
  {
    id: "google-weathernext-2",
    label: "WeatherNext 2 forecast",
    provider: "Google",
    category: "forecast",
    description: "Current global 0.25° 64-member, 15-day AI forecast.",
    sources: {
      map: {
        id: "google-weathernext-2",
        kind: "weathernext",
        url: "https://storage.googleapis.com/weathernext/weathernext_2_0_0/zarr",
        zarrVersion: 2,
        layout: "spatial",
        auth: "google",
        spatialDimensions: { lat: "lat", lon: "lon" },
        bounds: [0, -90, 360, 90],
        crs: "EPSG:4326",
        latIsAscending: true,
      },
    },
    support: "experimental",
    supportNote: "Requires Google authorization; each map chunk contains one global ensemble-member field.",
    defaultVariable: "total_precipitation_6hr",
  },
  {
    id: "weatherzarr-ecmwf-ifs",
    label: "ECMWF IFS forecast",
    provider: "WeatherZarr",
    category: "forecast",
    description: "Current global 0.25° IFS control forecast with paired map and point layouts.",
    sources: {
      map: {
        id: "weatherzarr-ecmwf-ifs-spatial",
        kind: "weatherzarr",
        url: "https://weatherzarr.com/data/ecmwf-ifs025/latest.json",
        zarrVersion: 3,
        layout: "spatial",
        spatialDimensions: { lat: "latitude", lon: "longitude" },
        bounds: [-180, -90, 180, 90],
        crs: "EPSG:4326",
        latIsAscending: false,
        precipitationAccumulation: "cumulative",
        geographicBounds: [-180, -90, 180, 90],
        meteogram: {
          kind: "global-control",
          firstLeadHour: 3,
        },
      },
      series: {
        id: "weatherzarr-ecmwf-ifs-timeseries",
        kind: "weatherzarr",
        url: "https://weatherzarr.com/data/ecmwf-ifs025/latest.json",
        zarrVersion: 3,
        layout: "timeseries",
        spatialDimensions: { lat: "latitude", lon: "longitude" },
        bounds: [-180, -90, 180, 90],
        crs: "EPSG:4326",
        latIsAscending: false,
        precipitationAccumulation: "cumulative",
        geographicBounds: [-180, -90, 180, 90],
        meteogram: {
          kind: "global-control",
        },
      },
    },
    support: "experimental",
    supportNote: "WeatherZarr retains a rolling set of recent operational runs.",
    defaultVariable: "tp",
  },
  {
    id: "google-arco-era5",
    label: "ECMWF ERA5 reanalysis",
    provider: "Google",
    category: "analysis",
    description: "Global hourly ERA5, spatially chunked for map reads.",
    sources: sharedSource({
      id: "google-arco-era5-spatial",
      kind: "google-arco",
      url: "https://storage.googleapis.com/gcp-public-data-arco-era5/ar/full_37-1h-0p25deg-chunk-1.zarr-v3",
      zarrVersion: 2,
      layout: "spatial",
      spatialDimensions: { lat: "latitude", lon: "longitude" },
      bounds: [0, -90, 360, 90],
      crs: "EPSG:4326",
      latIsAscending: false,
    }),
    support: "ready",
    defaultVariable: "total_precipitation",
  },
  {
    id: "ecmwf-arco-era5",
    label: "ECMWF ERA5 reanalysis",
    provider: "ECMWF ARCO",
    category: "analysis",
    description: "Global hourly ERA5 with official map- and point-optimized Zarr stores.",
    sources: {
      map: {
        id: "ecmwf-arco-era5-time-chunked",
        kind: "ecmwf-arco",
        url: "https://arco.datastores.ecmwf.int/cadl-arco-time-002/arco/reanalysis_era5_single_levels/sfc/timeChunked.zarr",
        zarrVersion: 2,
        auth: "cds-api-key",
        layout: "spatial",
        spatialDimensions: { lat: "latitude", lon: "longitude" },
        bounds: [-180, -90, 180, 90],
        crs: "EPSG:4326",
        latIsAscending: true,
      },
      series: {
        id: "ecmwf-arco-era5-geo-chunked",
        kind: "ecmwf-arco",
        url: "https://arco.datastores.ecmwf.int/cadl-arco-geo-002/arco/reanalysis_era5_single_levels/sfc/geoChunked.zarr",
        zarrVersion: 2,
        auth: "cds-api-key",
        layout: "timeseries",
        spatialDimensions: { lat: "latitude", lon: "longitude" },
        bounds: [-180, -90, 180, 90],
        crs: "EPSG:4326",
        latIsAscending: true,
      },
    },
    support: "experimental",
    supportNote: "Requires a CDS API key; ECMWF currently describes tokenized ARCO access as a beta service.",
    defaultVariable: "tp",
  },
  ...DYNAMICAL_DATASETS,
  {
    id: "earthmover-era5",
    label: "ECMWF ERA5 reanalysis",
    provider: "Earthmover",
    category: "analysis",
    description: "Open ERA5 single-level map and temporal layouts, 1940–2025.",
    sources: {
      map: {
        id: "earthmover-era5-single-spatial",
        kind: "icechunk",
        url: "https://earthmover-icechunk-era5.s3.us-east-1.amazonaws.com/icechunkV2",
        s3Url: "s3://earthmover-icechunk-era5/icechunkV2",
        group: "single/spatial",
        zarrVersion: 3,
        layout: "spatial",
        directChunkReads: true,
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
    defaultVariable: "tp",
  },
  {
    id: "salient-gemai-v3-reforecast",
    label: "Salient GemAI v3 reforecast",
    provider: "Salient",
    category: "forecast",
    description: "Global 0.25° 50-member extended-range reforecasts from 2000–2025.",
    sources: sharedSource({
      id: "salient-gemai-v3-reforecast",
      kind: "zarr",
      url: "https://gemv3-reforecast.salient-open-data.com/forecast",
      zarrVersion: 3,
      spatialDimensions: { lat: "lat", lon: "lon" },
      bounds: [-180, -90, 180, 90],
      crs: "EPSG:4326",
      latIsAscending: true,
    }),
    support: "experimental",
    supportNote: "Uses sharded PCodec chunks spanning seven leads and all 50 members.",
    defaultVariable: "mean_total_precipitation_rate",
  },
];

const DATASET_ALIASES: Record<string, string> = {
  "noaa-hrrr-forecast-48-hour-virtual": "noaa-hrrr-forecast-48-hour",
  "earthmover-era5-single-spatial": "earthmover-era5",
};

export const DEFAULT_DATASET_ID =
  import.meta.env?.VITE_DATASET_ID || "weatherzarr-ecmwf-ifs";

export const DATASET_CATEGORY_GROUPS = [
  { id: "forecast", label: "Forecast" },
  { id: "analysis", label: "Analysis/Reanalysis" },
] as const satisfies Array<{ id: DatasetCategory; label: string }>;

export function datasetChunkingLabel(dataset: DatasetConfig) {
  const layouts = new Set(
    Object.values(dataset.sources).flatMap((source) =>
      source ? [source.layout ?? "timeseries"] : []
    ),
  );
  if (layouts.size > 1) return "Dual-chunked";
  return layouts.has("spatial") ? "Spatially-chunked" : "Timeseries-chunked";
}

export function datasetOptionLabel(dataset: DatasetConfig) {
  return `${dataset.label} — ${dataset.provider}`;
}

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
