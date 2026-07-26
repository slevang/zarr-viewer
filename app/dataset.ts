import { IcechunkStore } from "icechunk-js";
import proj4 from "proj4";
import * as zarr from "zarrita";
import type { Selector, TransformRequest } from "@carbonplan/zarr-layer";
import type {
  AbsolutePath,
  GetOptions,
  RangeQuery,
  Readable,
} from "zarrita";
import {
  getDataset,
  getDatasetSource,
  type DatasetConfig,
  type DatasetSourceConfig,
  type DatasetSourceRole,
} from "./catalog";
import { createBoundedAsyncQueue } from "./async-queue";
import { registerFixedScaleOffset } from "./codecs/fixedscaleoffset";
import { registerGribberishCodec } from "./codecs/gribberish";
import { registerPcodec } from "./codecs/pcodec";
import {
  derivedVariableMatches,
  executeDerivedPipeline,
  nativeInputsForDerived,
} from "./derived-variables";
import {
  googleAuthorizedFetch,
} from "./google-auth";

registerGribberishCodec();
registerFixedScaleOffset();
registerPcodec();

export type AxisKind = "time" | "timedelta" | "number" | "category";

export type AxisConfig = {
  id: string;
  label: string;
  unit: string;
  kind: AxisKind;
  values: Array<number | string>;
  defaultIndex?: number;
  requiresStoreReload?: boolean;
};

export type DerivedTransformConfig = {
  id: string;
  kind: "elementwise";
  operator: string;
  inputs: string[];
};

export type DerivedVariableSpec = {
  key: string;
  inputs: Record<string, string>;
  transforms: DerivedTransformConfig[];
  output: string;
};

export type VariableConfig = {
  id: string;
  label: string;
  unit: string;
  standardName?: string;
  dimensions: string[];
  shape?: number[];
  chunkShape?: number[];
  innerChunkShape?: number[];
  dataType?: string;
  derived?: DerivedVariableSpec;
};

export type StoreInfo = {
  dataset: DatasetConfig;
  source: DatasetSourceConfig;
  role: DatasetSourceRole;
  variables: VariableConfig[];
  derivedVariables?: VariableConfig[];
  axes: Record<string, AxisConfig>;
  store?: Readable;
  layerOptions: {
    source?: string;
    store?: Readable;
    zarrVersion: 2 | 3;
    crs: string;
    bounds?: [number, number, number, number];
    latIsAscending?: boolean;
    spatialDimensions?: { lat: string; lon: string };
    proj4?: string;
    transformRequest?: TransformRequest;
  };
};

export type PointTimeSeries = {
  kind: "history";
  values: number[];
  dates: Date[];
  unit: string;
  variableLabel: string;
  latitude: number;
  longitude: number;
};

export type ForecastQuantiles = {
  min: number;
  q10: number;
  q25: number;
  q50: number;
  q75: number;
  q90: number;
  max: number;
};

export type PointForecastSeries = {
  kind: "forecast";
  quantiles: ForecastQuantiles[];
  dates: Date[];
  unit: string;
  variableLabel: string;
  latitude: number;
  longitude: number;
  memberCount: number;
};

export type PointSeries = PointTimeSeries | PointForecastSeries;

type ZarrMetadata = {
  node_type?: string;
  shape?: number[];
  data_type?: string;
  dimension_names?: Array<string | null>;
  attributes?: Record<string, unknown>;
  chunk_grid?: {
    configuration?: {
      chunk_shape?: number[];
    };
  };
  codecs?: Array<{
    name?: string;
    configuration?: {
      chunk_shape?: number[];
    };
  }>;
};

type ConsolidatedMetadata = {
  metadata?: Record<string, Record<string, unknown>>;
};

type ZarrV2ArrayMetadata = {
  shape?: unknown;
  chunks?: unknown;
  dtype?: unknown;
};

type ZarrV3RootMetadata = {
  zarr_format?: number;
  node_type?: string;
  attributes?: Record<string, unknown>;
  consolidated_metadata?: {
    kind?: string;
    metadata?: Record<string, ZarrMetadata>;
  };
};

type WeatherZarrStore = {
  var: string;
  layout: "spatial" | "timeseries";
  key: string;
  units?: string;
  chunks: number[];
  shape: number[];
  dims: string[];
  url?: string;
};

type WeatherZarrManifest = {
  run: string;
  stores: WeatherZarrStore[];
};

type WeatherZarrCatalogRun = {
  run: string;
  manifest: string;
};

type WeatherZarrCatalog = {
  models?: Record<string, WeatherZarrCatalogRun[]>;
};

export type AxisSelection = Record<string, number>;

const GOOGLE_TIME_ORIGIN_MS = Date.UTC(1900, 0, 1);
const HOUR_MS = 60 * 60 * 1000;
const STORE_READ_CONCURRENCY = 32;
const STORE_READ_CACHE_BYTES = 1024 * 1024 * 1024;
const SERIES_CHUNK_CONCURRENCY = 6;
const GOOGLE_FETCH_ATTEMPTS = 3;
export const SERIES_LOOKAHEAD_MS = 15 * 24 * HOUR_MS;
export const SERIES_LOOKAHEAD_HOURS = SERIES_LOOKAHEAD_MS / HOUR_MS;
const GOOGLE_LEVELS = [
  1, 2, 3, 5, 7, 10, 20, 30, 50, 70, 100, 125, 150, 175, 200, 225,
  250, 300, 350, 400, 450, 500, 550, 600, 650, 700, 750, 775, 800, 825,
  850, 875, 900, 925, 950, 975, 1000,
];

function product(values: number[]) {
  return values.reduce((result, value) => result * value, 1);
}

function normalizeValue(value: unknown): number | string {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" || typeof value === "string") return value;
  return String(value);
}

function axisKind(name: string, attrs: Record<string, unknown>, dataType = ""): AxisKind {
  const standardName = typeof attrs.standard_name === "string"
    ? attrs.standard_name.toLowerCase()
    : "";
  const units = typeof attrs.units === "string" ? attrs.units.toLowerCase() : "";
  const dtype = typeof attrs.dtype === "string" ? attrs.dtype.toLowerCase() : dataType;
  const lowerName = name.toLowerCase();

  if (
    standardName === "time"
    || standardName === "forecast_reference_time"
    || units.includes(" since ")
    || lowerName === "time"
    || lowerName === "init_time"
    || lowerName === "valid_time"
  ) return "time";

  if (
    standardName === "forecast_period"
    || dtype.includes("timedelta")
    || lowerName.includes("lead_time")
    || lowerName === "step"
  ) return "timedelta";

  if (dataType === "string" || dataType === "v2:object") return "category";
  return "number";
}

function axisLabel(name: string, attrs: Record<string, unknown>) {
  if (name.toLowerCase() === "sample") return "Ensemble member";
  const longName = typeof attrs.long_name === "string" ? attrs.long_name.trim() : "";
  return longName || name.replaceAll("_", " ");
}

function isSpatialDimension(name: string, source: DatasetSourceConfig) {
  const lowerName = name.toLowerCase();
  const configured = source.spatialDimensions;
  return (
    lowerName === "latitude"
    || lowerName === "longitude"
    || lowerName === "lat"
    || lowerName === "lon"
    || lowerName === "x"
    || lowerName === "y"
    || configured?.lat === name
    || configured?.lon === name
  );
}

function defaultLayerOptions(
  source: DatasetSourceConfig,
  store?: Readable,
): StoreInfo["layerOptions"] {
  return {
    ...(store ? { store } : { source: source.url }),
    zarrVersion: source.zarrVersion,
    crs: source.crs ?? "EPSG:4326",
    bounds: source.bounds,
    latIsAscending: source.latIsAscending,
    spatialDimensions: source.spatialDimensions,
    proj4: source.proj4,
  };
}

function cacheStoreReads(
  store: Readable,
  limit = STORE_READ_CONCURRENCY,
  maxBytes = STORE_READ_CACHE_BYTES,
): Readable {
  let active = 0;
  let cachedBytes = 0;
  const queue: Array<() => void> = [];
  const cache = new Map<string, Uint8Array>();
  const pending = new Map<string, Promise<Uint8Array | undefined>>();

  const drain = () => {
    while (active < limit && queue.length > 0) {
      queue.shift()?.();
    }
  };

  const schedule = <T,>(task: () => Promise<T>) => new Promise<T>((resolve, reject) => {
    queue.push(() => {
      active += 1;
      void task().then(resolve, reject).finally(() => {
        active -= 1;
        drain();
      });
    });
    drain();
  });

  const remember = (key: string, value: Uint8Array) => {
    if (value.byteLength > maxBytes) return;
    const existing = cache.get(key);
    if (existing) cachedBytes -= existing.byteLength;
    cache.delete(key);
    cache.set(key, value);
    cachedBytes += value.byteLength;
    while (cachedBytes > maxBytes) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = cache.get(oldestKey);
      cache.delete(oldestKey);
      cachedBytes -= oldest?.byteLength ?? 0;
    }
  };

  const read = (
    cacheKey: string,
    task: () => Promise<Uint8Array | undefined>,
  ) => {
    const cached = cache.get(cacheKey);
    if (cached) {
      cache.delete(cacheKey);
      cache.set(cacheKey, cached);
      return Promise.resolve(cached);
    }
    const inProgress = pending.get(cacheKey);
    if (inProgress) return inProgress;
    const promise = schedule(task).then((value) => {
      if (value) remember(cacheKey, value);
      return value;
    }).finally(() => {
      pending.delete(cacheKey);
    });
    pending.set(cacheKey, promise);
    return promise;
  };

  const cachedGet = (key: AbsolutePath, options?: GetOptions) =>
    read(`get:${key}`, () => Promise.resolve(store.get(key, options)));
  const cachedGetRange = store.getRange
    ? (key: AbsolutePath, query: RangeQuery, options?: GetOptions) =>
      read(
        `range:${key}:${JSON.stringify(query)}`,
        () => Promise.resolve(store.getRange?.(key, query, options)),
      )
    : undefined;

  return new Proxy(store, {
    get(target, property) {
      if (property === "get") return cachedGet;
      if (property === "getRange" && cachedGetRange) return cachedGetRange;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as unknown as Readable;
}

async function readCoordinate(
  store: IcechunkStore,
  dimension: string,
  expectedLength: number,
): Promise<AxisConfig> {
  const metadata = store.getMetadata(dimension) as ZarrMetadata | null;
  const attrs = metadata?.attributes ?? {};
  let values: Array<number | string>;

  if (metadata?.node_type === "array" && product(metadata.shape ?? []) <= 1_000_000) {
    const array = await zarr.open(zarr.root(store).resolve(dimension), { kind: "array" });
    const result = await zarr.get(array);
    values = Array.from(result.data as ArrayLike<unknown>, normalizeValue);
  } else {
    values = Array.from({ length: expectedLength }, (_, index) => index);
  }

  return {
    id: dimension,
    label: axisLabel(dimension, attrs),
    unit: typeof attrs.units === "string" ? attrs.units : "",
    kind: axisKind(dimension, attrs, metadata?.data_type),
    values,
  };
}

async function loadIcechunkStoreInfo(
  dataset: DatasetConfig,
  source: DatasetSourceConfig,
  role: DatasetSourceRole,
): Promise<StoreInfo> {
  const repository = await IcechunkStore.open(source.url);
  const store = source.group ? repository.resolve(source.group) : repository;
  const childNames = store.listChildren();
  const variables: VariableConfig[] = [];
  const dimensionLengths = new Map<string, number>();

  for (const id of childNames) {
    const metadata = store.getMetadata(id) as ZarrMetadata | null;
    if (metadata?.node_type !== "array") continue;
    const dimensions = metadata.dimension_names?.filter(
      (dimension): dimension is string => typeof dimension === "string",
    ) ?? [];
    const hasLatitude = dimensions.some((dimension) =>
      ["latitude", "lat", "y", source.spatialDimensions?.lat].includes(dimension),
    );
    const hasLongitude = dimensions.some((dimension) =>
      ["longitude", "lon", "x", source.spatialDimensions?.lon].includes(dimension),
    );
    if (!hasLatitude || !hasLongitude) continue;

    dimensions.forEach((dimension, index) => {
      if (!isSpatialDimension(dimension, source)) {
        dimensionLengths.set(
          dimension,
          Math.max(dimensionLengths.get(dimension) ?? 0, metadata.shape?.[index] ?? 0),
        );
      }
    });

    const attrs = metadata.attributes ?? {};
    const longName = typeof attrs.long_name === "string" ? attrs.long_name.trim() : "";
    variables.push({
      id,
      label: longName || id.replaceAll("_", " "),
      unit: typeof attrs.units === "string" ? attrs.units : "",
      standardName: typeof attrs.standard_name === "string"
        ? attrs.standard_name
        : undefined,
      dimensions,
      shape: metadata.shape,
      chunkShape: metadata.chunk_grid?.configuration?.chunk_shape,
      innerChunkShape: metadata.codecs?.find(
        (codec) => codec.name === "sharding_indexed",
      )?.configuration?.chunk_shape,
      dataType: metadata.data_type,
    });
  }

  if (!variables.length) {
    throw new Error("This store did not report any compatible spatial variables");
  }

  const axes: Record<string, AxisConfig> = {};
  await Promise.all(Array.from(dimensionLengths, async ([dimension, length]) => {
    axes[dimension] = await readCoordinate(store, dimension, length);
  }));

  variables.sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );

  return {
    dataset,
    source,
    role,
    variables,
    axes,
    store,
    layerOptions: defaultLayerOptions(source, cacheStoreReads(store)),
  };
}

function variablesFromV3Metadata(
  metadata: Record<string, ZarrMetadata>,
  source: DatasetSourceConfig,
) {
  const variables: VariableConfig[] = [];
  const dimensionLengths = new Map<string, number>();

  for (const [id, arrayMetadata] of Object.entries(metadata)) {
    if (arrayMetadata.node_type !== "array") continue;
    const dimensions = arrayMetadata.dimension_names?.filter(
      (dimension): dimension is string => typeof dimension === "string",
    ) ?? [];
    const hasLatitude = dimensions.some((dimension) =>
      ["latitude", "lat", "y", source.spatialDimensions?.lat].includes(dimension),
    );
    const hasLongitude = dimensions.some((dimension) =>
      ["longitude", "lon", "x", source.spatialDimensions?.lon].includes(dimension),
    );
    if (!hasLatitude || !hasLongitude) continue;

    dimensions.forEach((dimension, index) => {
      if (!isSpatialDimension(dimension, source)) {
        dimensionLengths.set(
          dimension,
          Math.max(
            dimensionLengths.get(dimension) ?? 0,
            arrayMetadata.shape?.[index] ?? 0,
          ),
        );
      }
    });

    const attrs = arrayMetadata.attributes ?? {};
    const longName = typeof attrs.long_name === "string" ? attrs.long_name.trim() : "";
    variables.push({
      id,
      label: longName || id.replaceAll("_", " "),
      unit: typeof attrs.units === "string" ? attrs.units : "",
      standardName: typeof attrs.standard_name === "string"
        ? attrs.standard_name
        : undefined,
      dimensions,
      shape: arrayMetadata.shape,
      chunkShape: arrayMetadata.chunk_grid?.configuration?.chunk_shape,
      innerChunkShape: arrayMetadata.codecs?.find(
        (codec) => codec.name === "sharding_indexed",
      )?.configuration?.chunk_shape,
      dataType: arrayMetadata.data_type,
    });
  }

  variables.sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );
  return { variables, dimensionLengths };
}

async function readV3Coordinate(
  store: Readable,
  metadata: Record<string, ZarrMetadata>,
  dimension: string,
  expectedLength: number,
): Promise<AxisConfig> {
  const arrayMetadata = metadata[dimension];
  const attrs = arrayMetadata?.attributes ?? {};
  let values: Array<number | string>;

  if (
    arrayMetadata?.node_type === "array"
    && product(arrayMetadata.shape ?? []) <= 1_000_000
  ) {
    const array = await zarr.open(zarr.root(store).resolve(dimension), {
      kind: "array",
    });
    const result = await zarr.get(array);
    values = Array.from(result.data as ArrayLike<unknown>, normalizeValue);
  } else {
    values = Array.from({ length: expectedLength }, (_, index) => index);
  }

  return {
    id: dimension,
    label: axisLabel(dimension, attrs),
    unit: typeof attrs.units === "string" ? attrs.units : "",
    kind: axisKind(dimension, attrs, arrayMetadata?.data_type),
    values,
  };
}

async function fetchV3Root(url: string) {
  const response = await fetch(`${url.replace(/\/$/, "")}/zarr.json`);
  if (!response.ok) {
    throw new Error(`Zarr metadata request failed (${response.status})`);
  }
  const root = await response.json() as ZarrV3RootMetadata;
  const metadata = root.consolidated_metadata?.metadata;
  if (!metadata) {
    throw new Error("The Zarr v3 store does not contain inline consolidated metadata");
  }
  return { root, metadata };
}

async function axesFromV3Metadata(
  store: Readable,
  metadata: Record<string, ZarrMetadata>,
  dimensionLengths: Map<string, number>,
) {
  const axes: Record<string, AxisConfig> = {};
  await Promise.all(Array.from(dimensionLengths, async ([dimension, length]) => {
    axes[dimension] = await readV3Coordinate(
      store,
      metadata,
      dimension,
      length,
    );
  }));
  return axes;
}

async function loadV3StoreInfo(
  dataset: DatasetConfig,
  source: DatasetSourceConfig,
  role: DatasetSourceRole,
): Promise<StoreInfo> {
  const { metadata } = await fetchV3Root(source.url);
  const store = new zarr.FetchStore(source.url);
  const { variables, dimensionLengths } = variablesFromV3Metadata(
    metadata,
    source,
  );
  if (!variables.length) {
    throw new Error("This store did not report any compatible spatial variables");
  }
  const axes = await axesFromV3Metadata(store, metadata, dimensionLengths);
  const timeLength = dimensionLengths.get("time");
  if (
    timeLength
    && metadata.datetime?.node_type === "array"
    && metadata.datetime.dimension_names?.includes("time")
  ) {
    const validTime = await readV3Coordinate(
      store,
      metadata,
      "datetime",
      timeLength,
    );
    axes.time = {
      ...validTime,
      id: "time",
      label: "Valid time",
      kind: "time",
    };
  }
  const cachedStore = cacheStoreReads(store);

  return {
    dataset,
    source,
    role,
    variables,
    axes,
    store: cachedStore,
    layerOptions: defaultLayerOptions(source, cachedStore),
  };
}

function googleStorageLocation(url: string) {
  const parsed = new URL(url);
  if (parsed.hostname !== "storage.googleapis.com") {
    throw new Error(`Unsupported Google Cloud Storage URL: ${url}`);
  }
  const [bucket, ...objectParts] = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  if (!bucket || !objectParts.length) {
    throw new Error(`Google Cloud Storage URL does not include an object path: ${url}`);
  }
  return { bucket, object: objectParts.join("/") };
}

function googleStorageMediaUrl(url: string) {
  const { bucket, object } = googleStorageLocation(url);
  return `https://storage.googleapis.com/download/storage/v1/b/${
    encodeURIComponent(bucket)
  }/o/${encodeURIComponent(object)}?alt=media`;
}

async function fetchWeatherNextObject(request: Request) {
  const response = await googleAuthorizedFetch(
    new Request(googleStorageMediaUrl(request.url), request),
  );
  if (!response.ok || !new URL(request.url).pathname.endsWith("/.zarray")) {
    return response;
  }
  const metadata = await response.clone().json() as Record<string, unknown>;
  if (
    typeof metadata.dtype !== "string"
    || !/^([<|>])[mM]8\[[^\]]+\]$/.test(metadata.dtype)
  ) {
    return response;
  }
  metadata.dtype = metadata.dtype.replace(/[mM]8\[[^\]]+\]$/, "i8");
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("etag");
  return new Response(JSON.stringify(metadata), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function weatherNextPeriod(date: Date) {
  const year = date.getUTCFullYear();
  if (year >= 2025) return "2025_to_present";
  if (year >= 2022) return `${year}_to_${year + 1}`;
  throw new Error("WeatherNext 2 forecasts are only available from 2022");
}

function weatherNextDateId(date: Date) {
  return [
    date.getUTCFullYear().toString().padStart(4, "0"),
    (date.getUTCMonth() + 1).toString().padStart(2, "0"),
    date.getUTCDate().toString().padStart(2, "0"),
  ].join("");
}

export function weatherNextStoreUrl(
  sourceRoot: string,
  initializationDate: Date,
) {
  const root = sourceRoot.replace(/\/$/, "");
  const cycleHour = Math.floor(initializationDate.getUTCHours() / 6) * 6;
  const run = `${weatherNextDateId(initializationDate)}_${
    cycleHour.toString().padStart(2, "0")
  }hr_01_preds`;
  return `${root}/${weatherNextPeriod(initializationDate)}/${run}/predictions.zarr`;
}

function weatherNextCycleAtOrBefore(date: Date) {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    Math.floor(date.getUTCHours() / 6) * 6,
  ));
}

function previousWeatherNextCycle(date: Date, offset: number) {
  return new Date(
    weatherNextCycleAtOrBefore(date).getTime() - offset * 6 * HOUR_MS,
  );
}

async function resolveWeatherNextStore(
  source: DatasetSourceConfig,
  targetDate?: Date,
) {
  const now = new Date();
  const requested = targetDate && Number.isFinite(targetDate.getTime())
    ? targetDate
    : now;
  const start = requested.getTime() > now.getTime() ? now : requested;

  for (let offset = 0; offset < 16; offset += 1) {
    const candidateDate = previousWeatherNextCycle(start, offset);
    if (candidateDate.getUTCFullYear() < 2022) break;
    const url = weatherNextStoreUrl(source.url, candidateDate);
    const response = await googleAuthorizedFetch(
      googleStorageMediaUrl(`${url}/.zmetadata`),
      { cache: "no-store" },
    );
    if (response.ok) {
      return {
        url,
        initializationDate: candidateDate,
        consolidated: await response.json() as ConsolidatedMetadata,
      };
    }
    if (response.status === 404) continue;
    if (response.status === 403) {
      throw new Error(
        "This Google account does not have access to this WeatherNext forecast",
      );
    }
    const detail = (await response.text()).slice(0, 300);
    throw new Error(
      `WeatherNext metadata request failed (${response.status})${
        detail ? `: ${detail}` : ""
      }`,
    );
  }
  throw new Error(
    "No WeatherNext forecast was found in the recent six-hour cycles near the selected date",
  );
}

function numericArray(value: unknown): number[] | undefined {
  return Array.isArray(value)
    && value.every((item) => typeof item === "number")
    ? value
    : undefined;
}

const WEATHER_NEXT_UNITS: Record<string, string> = {
  total_precipitation_6hr: "m",
  "10m_u_component_of_wind": "m/s",
  "10m_v_component_of_wind": "m/s",
  "100m_u_component_of_wind": "m/s",
  "100m_v_component_of_wind": "m/s",
  "100m_wind_speed": "m/s",
  "2m_temperature": "K",
  mean_sea_level_pressure: "Pa",
  sea_surface_temperature: "K",
  geopotential: "m^2/s^2",
  specific_humidity: "kg/kg",
  temperature: "K",
  u_component_of_wind: "m/s",
  v_component_of_wind: "m/s",
  vertical_velocity: "Pa/s",
};

export function weatherNextVariableUnit(variableId: string) {
  return WEATHER_NEXT_UNITS[variableId] ?? "";
}

function metadataUnit(
  attrs: Record<string, unknown>,
  source: DatasetSourceConfig,
  variableId: string,
) {
  const entry = Object.entries(attrs).find(([key, value]) =>
    ["unit", "units"].includes(key.toLowerCase())
    && typeof value === "string"
  );
  if (entry && typeof entry[1] === "string") return entry[1];
  return source.kind === "weathernext"
    ? weatherNextVariableUnit(variableId)
    : "";
}

function variablesFromV2Metadata(
  consolidated: ConsolidatedMetadata,
  source: DatasetSourceConfig,
) {
  const metadata = consolidated.metadata ?? {};
  const variables: VariableConfig[] = [];
  const dimensionLengths = new Map<string, number>();

  for (const [key, attrs] of Object.entries(metadata)) {
    if (!key.endsWith("/.zattrs")) continue;
    const id = key.slice(0, -"/.zattrs".length);
    if (id.includes("/")) continue;
    const dimensions = attrs._ARRAY_DIMENSIONS;
    if (
      !Array.isArray(dimensions)
      || !dimensions.every((value) => typeof value === "string")
    ) continue;
    const typedDimensions = dimensions as string[];
    const hasLatitude = typedDimensions.some((dimension) =>
      ["latitude", "lat", "y", source.spatialDimensions?.lat].includes(dimension)
    );
    const hasLongitude = typedDimensions.some((dimension) =>
      ["longitude", "lon", "x", source.spatialDimensions?.lon].includes(dimension)
    );
    if (!hasLatitude || !hasLongitude) continue;

    const arrayMetadata = metadata[`${id}/.zarray`] as
      | ZarrV2ArrayMetadata
      | undefined;
    const shape = numericArray(arrayMetadata?.shape);
    typedDimensions.forEach((dimension, index) => {
      if (!isSpatialDimension(dimension, source)) {
        dimensionLengths.set(
          dimension,
          Math.max(
            dimensionLengths.get(dimension) ?? 0,
            shape?.[index] ?? 0,
          ),
        );
      }
    });
    const longName = typeof attrs.long_name === "string"
      ? attrs.long_name.trim()
      : "";
    variables.push({
      id,
      label: longName || id.replaceAll("_", " "),
      unit: metadataUnit(attrs, source, id),
      standardName: typeof attrs.standard_name === "string"
        ? attrs.standard_name
        : undefined,
      dimensions: typedDimensions,
      shape,
      chunkShape: numericArray(arrayMetadata?.chunks),
      dataType: typeof arrayMetadata?.dtype === "string"
        ? arrayMetadata.dtype
        : undefined,
    });
  }
  variables.sort((first, second) =>
    first.label.localeCompare(second.label, undefined, { sensitivity: "base" })
  );
  return { variables, dimensionLengths };
}

async function readV2Coordinate(
  store: Readable,
  consolidated: ConsolidatedMetadata,
  dimension: string,
  expectedLength: number,
): Promise<AxisConfig> {
  const metadata = consolidated.metadata ?? {};
  const attrs = metadata[`${dimension}/.zattrs`] ?? {};
  const arrayMetadata = metadata[`${dimension}/.zarray`] as
    | ZarrV2ArrayMetadata
    | undefined;
  const shape = numericArray(arrayMetadata?.shape);
  let values: Array<number | string>;

  if (shape && product(shape) <= 1_000_000) {
    const array = await zarr.open(zarr.root(store).resolve(dimension), {
      kind: "array",
    });
    const result = await zarr.get(array);
    values = Array.from(result.data as ArrayLike<unknown>, normalizeValue);
  } else {
    values = Array.from({ length: expectedLength }, (_, index) => index);
  }

  const dataType = typeof arrayMetadata?.dtype === "string"
    ? arrayMetadata.dtype
    : "";
  return {
    id: dimension,
    label: axisLabel(dimension, attrs),
    unit: typeof attrs.units === "string" ? attrs.units : "",
    kind: axisKind(dimension, attrs, dataType),
    values,
  };
}

async function loadWeatherNextStoreInfo(
  dataset: DatasetConfig,
  source: DatasetSourceConfig,
  role: DatasetSourceRole,
  targetDate?: Date,
): Promise<StoreInfo> {
  const { url, initializationDate, consolidated } = await resolveWeatherNextStore(
    source,
    targetDate,
  );
  const resolvedSource = { ...source, url };
  const store = new zarr.FetchStore(url, {
    fetch: fetchWeatherNextObject,
  });
  const { variables, dimensionLengths } = variablesFromV2Metadata(
    consolidated,
    resolvedSource,
  );
  if (!variables.length) {
    throw new Error("WeatherNext did not report any compatible spatial variables");
  }
  const axes: Record<string, AxisConfig> = {};
  await Promise.all(Array.from(dimensionLengths, async ([dimension, length]) => {
    axes[dimension] = await readV2Coordinate(
      store,
      consolidated,
      dimension,
      length,
    );
  }));
  const timeMetadata = consolidated.metadata?.["time/.zarray"] as
    | ZarrV2ArrayMetadata
    | undefined;
  if (axes.time) {
    const durationUnit = typeof timeMetadata?.dtype === "string"
      && timeMetadata.dtype.toLowerCase().includes("m8[ns]")
      ? "nanoseconds"
      : axes.time.unit || "seconds";
    axes.time = {
      ...axes.time,
      label: "Lead time",
      kind: "timedelta",
      unit: durationUnit,
    };
  }
  const firstInitialization = Date.UTC(2022, 0, 1);
  const lastInitialization = weatherNextCycleAtOrBefore(new Date()).getTime();
  const initializationValues = Array.from(
    {
      length: Math.floor(
        (lastInitialization - firstInitialization) / (6 * HOUR_MS),
      ) + 1,
    },
    (_, index) => (firstInitialization + index * 6 * HOUR_MS) / 1_000,
  );
  axes.init_time = {
    id: "init_time",
    label: "Initialization time",
    unit: "seconds since 1970-01-01T00:00:00Z",
    kind: "time",
    values: initializationValues,
    defaultIndex: Math.max(
      0,
      Math.min(
        initializationValues.length - 1,
        Math.round(
          (initializationDate.getTime() - firstInitialization) / (6 * HOUR_MS),
        ),
      ),
    ),
    requiresStoreReload: true,
  };
  const cachedStore = cacheStoreReads(store);
  return {
    dataset,
    source: resolvedSource,
    role,
    variables,
    axes,
    store: cachedStore,
    layerOptions: defaultLayerOptions(resolvedSource, cachedStore),
  };
}

function weatherZarrProxyUrl(key: string) {
  const normalized = key.replace(/^\/+/, "").replace(/^wxmap\//, "");
  return `https://weatherzarr.com/${normalized}`;
}

function weatherZarrRunDate(run: string) {
  const match = run.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?Z$/,
  );
  return match
    ? new Date(Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6] ?? 0),
    ))
    : new Date(run);
}

async function resolveWeatherZarrManifest(
  latestUrl: string,
  targetDate?: Date,
) {
  const parsed = new URL(latestUrl);
  const segments = parsed.pathname.split("/").filter(Boolean);
  const dataIndex = segments.indexOf("data");
  const model = dataIndex >= 0 ? segments[dataIndex + 1] : undefined;
  const catalogResponse = await fetch(
    new URL("/catalog.json", parsed.origin),
    { cache: "no-store" },
  );
  if (!catalogResponse.ok) {
    throw new Error(`WeatherZarr catalog request failed (${catalogResponse.status})`);
  }
  const catalog = await catalogResponse.json() as WeatherZarrCatalog;
  const runs = model ? catalog.models?.[model] ?? [] : [];
  if (!runs.length) {
    throw new Error("WeatherZarr catalog did not report any available runs");
  }
  const selectedRun = targetDate && Number.isFinite(targetDate.getTime())
    ? runs.reduce((nearest, candidate) => (
      Math.abs(weatherZarrRunDate(candidate.run).getTime() - targetDate.getTime())
        < Math.abs(weatherZarrRunDate(nearest.run).getTime() - targetDate.getTime())
        ? candidate
        : nearest
    ))
    : runs.reduce((latest, candidate) => (
      weatherZarrRunDate(candidate.run).getTime()
        > weatherZarrRunDate(latest.run).getTime()
        ? candidate
        : latest
    ));
  const manifestResponse = await fetch(
    weatherZarrProxyUrl(selectedRun.manifest),
    { cache: "no-store" },
  );
  if (!manifestResponse.ok) {
    throw new Error(`WeatherZarr manifest request failed (${manifestResponse.status})`);
  }
  const manifest = await manifestResponse.json() as WeatherZarrManifest;
  return { manifest, runs, selectedRun };
}

function createWeatherZarrStore(
  rootMetadata: ZarrV3RootMetadata,
  metadata: Record<string, ZarrMetadata>,
  storesByNode: Map<string, zarr.FetchStore>,
  fallbackStore: zarr.FetchStore,
): Readable {
  const rootBytes = new TextEncoder().encode(JSON.stringify({
    ...rootMetadata,
    consolidated_metadata: {
      kind: "inline",
      must_understand: false,
      metadata,
    },
  }));
  const route = (key: string) => {
    const node = key.split("/").filter(Boolean)[0];
    return storesByNode.get(node) ?? fallbackStore;
  };
  const range = (
    bytes: Uint8Array,
    query: Parameters<NonNullable<Readable["getRange"]>>[1],
  ) => {
    if ("suffixLength" in query) {
      return bytes.slice(Math.max(0, bytes.length - query.suffixLength));
    }
    return bytes.slice(query.offset, query.offset + query.length);
  };
  return {
    async get(key, options) {
      if (key === "/zarr.json") return rootBytes;
      return route(key).get(key, options);
    },
    async getRange(key, query, options) {
      if (key === "/zarr.json") return range(rootBytes, query);
      return route(key).getRange(key, query, options);
    },
  };
}

async function loadWeatherZarrStoreInfo(
  dataset: DatasetConfig,
  source: DatasetSourceConfig,
  role: DatasetSourceRole,
  targetDate?: Date,
): Promise<StoreInfo> {
  const { manifest, runs, selectedRun } = await resolveWeatherZarrManifest(
    source.url,
    targetDate,
  );
  const layout = role === "map" ? "spatial" : "timeseries";
  const entries = manifest.stores.filter((entry) => entry.layout === layout);
  if (!entries.length) {
    throw new Error(`WeatherZarr run ${manifest.run} has no ${layout} stores`);
  }

  const roots = await Promise.all(entries.map(async (entry) => {
    const url = weatherZarrProxyUrl(entry.key);
    const { root, metadata } = await fetchV3Root(url);
    return {
      entry,
      url,
      root,
      metadata,
      store: new zarr.FetchStore(url),
    };
  }));
  const combinedMetadata: Record<string, ZarrMetadata> = {};
  const storesByNode = new Map<string, zarr.FetchStore>();
  for (const item of roots) {
    for (const [node, metadata] of Object.entries(item.metadata)) {
      if (node === item.entry.var || !(node in combinedMetadata)) {
        combinedMetadata[node] = metadata;
      }
      if (node === item.entry.var || !storesByNode.has(node)) {
        storesByNode.set(node, item.store);
      }
    }
  }
  const first = roots[0];
  const multiplexed = createWeatherZarrStore(
    first.root,
    combinedMetadata,
    storesByNode,
    first.store,
  );
  const { variables, dimensionLengths } = variablesFromV3Metadata(
    combinedMetadata,
    source,
  );
  if (!variables.length) {
    throw new Error("WeatherZarr did not report any compatible spatial variables");
  }
  const axes = await axesFromV3Metadata(
    multiplexed,
    combinedMetadata,
    dimensionLengths,
  );
  const validTimeLength = dimensionLengths.get("valid_time");
  if (
    validTimeLength
    && combinedMetadata.step?.node_type === "array"
    && combinedMetadata.step.dimension_names?.includes("valid_time")
  ) {
    const leadTime = await readV3Coordinate(
      multiplexed,
      combinedMetadata,
      "step",
      validTimeLength,
    );
    axes.valid_time = {
      ...leadTime,
      id: "valid_time",
      label: "Lead time",
      kind: "timedelta",
    };
  }
  const initializationValues = runs
    .map((run) => weatherZarrRunDate(run.run).getTime() / 1_000)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const selectedInitialization = weatherZarrRunDate(selectedRun.run).getTime() / 1_000;
  axes.init_time = {
    id: "init_time",
    label: "Initialization time",
    unit: "seconds since 1970-01-01T00:00:00Z",
    kind: "time",
    values: initializationValues,
    defaultIndex: Math.max(
      0,
      initializationValues.findIndex(
        (value) => value === selectedInitialization,
      ),
    ),
    requiresStoreReload: true,
  };
  const cachedStore = cacheStoreReads(multiplexed);

  return {
    dataset,
    source,
    role,
    variables,
    axes,
    store: cachedStore,
    layerOptions: defaultLayerOptions(source, cachedStore),
  };
}

function transformGoogleRequest(url: string) {
  const parsed = new URL(url);
  const marker = "/gcp-public-data-arco-era5/";
  const markerIndex = parsed.pathname.indexOf(marker);
  if (markerIndex < 0) return { url };
  const objectName = parsed.pathname.slice(markerIndex + marker.length);
  return {
    url: `https://storage.googleapis.com/download/storage/v1/b/gcp-public-data-arco-era5/o/${encodeURIComponent(objectName)}?alt=media`,
  };
}

function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchGoogleObject(request: Request) {
  let lastError: unknown;
  for (let attempt = 0; attempt < GOOGLE_FETCH_ATTEMPTS; attempt += 1) {
    request.signal.throwIfAborted();
    try {
      const transformed = transformGoogleRequest(request.url);
      const response = await fetch(new Request(transformed.url, request));
      if (
        response.ok
        || (response.status < 500 && response.status !== 429)
        || attempt === GOOGLE_FETCH_ATTEMPTS - 1
      ) return response;
      await response.body?.cancel();
      lastError = new Error(`Google ERA5 request failed (${response.status})`);
    } catch (error) {
      if (request.signal.aborted) throw error;
      lastError = error;
    }
    await abortableDelay(250 * 2 ** attempt, request.signal);
  }
  throw lastError;
}

async function loadGoogleStoreInfo(
  dataset: DatasetConfig,
  source: DatasetSourceConfig,
  role: DatasetSourceRole,
): Promise<StoreInfo> {
  const response = await fetch(transformGoogleRequest(`${source.url}/.zmetadata`).url);
  if (!response.ok) throw new Error(`Store metadata request failed (${response.status})`);
  const consolidated = (await response.json()) as ConsolidatedMetadata;
  const attrs = consolidated.metadata?.[".zattrs"];
  const start = typeof attrs?.valid_time_start === "string" ? attrs.valid_time_start : undefined;
  const stop = typeof attrs?.valid_time_stop_era5t === "string"
    ? attrs.valid_time_stop_era5t
    : typeof attrs?.valid_time_stop === "string"
      ? attrs.valid_time_stop
      : undefined;
  if (!start || !stop) throw new Error("The store did not report its time range");

  const minTime = Math.round(
    (new Date(`${start}T00:00:00Z`).getTime() - GOOGLE_TIME_ORIGIN_MS) / HOUR_MS,
  );
  const maxTime = Math.round(
    (new Date(`${stop}T23:00:00Z`).getTime() - GOOGLE_TIME_ORIGIN_MS) / HOUR_MS,
  );
  const variables: VariableConfig[] = [];

  for (const [key, variableAttrs] of Object.entries(consolidated.metadata ?? {})) {
    if (!key.endsWith("/.zattrs")) continue;
    const id = key.slice(0, -"/.zattrs".length);
    if (id.includes("/")) continue;
    const dimensions = variableAttrs._ARRAY_DIMENSIONS;
    const arrayMetadata = consolidated.metadata?.[`${id}/.zarray`];
    if (!Array.isArray(dimensions) || !dimensions.every((value) => typeof value === "string")) continue;
    if (!dimensions.includes("time") || !dimensions.includes("latitude") || !dimensions.includes("longitude")) continue;
    if (dimensions.some((dimension) => !["time", "level", "latitude", "longitude"].includes(dimension))) continue;
    const longName = typeof variableAttrs.long_name === "string" ? variableAttrs.long_name.trim() : "";
    variables.push({
      id,
      label: longName || id,
      unit: typeof variableAttrs.units === "string" ? variableAttrs.units : "",
      standardName: typeof variableAttrs.standard_name === "string"
        ? variableAttrs.standard_name
        : undefined,
      dimensions,
      shape: Array.isArray(arrayMetadata?.shape)
        && arrayMetadata.shape.every((value) => typeof value === "number")
        ? arrayMetadata.shape
        : undefined,
      chunkShape: Array.isArray(arrayMetadata?.chunks)
        && arrayMetadata.chunks.every((value) => typeof value === "number")
        ? arrayMetadata.chunks
        : undefined,
      dataType: typeof arrayMetadata?.dtype === "string"
        ? arrayMetadata.dtype
        : undefined,
    });
  }

  variables.sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );

  // Native map layers can read through transformRequest, but derived layers
  // need a Zarrita store so they can fetch and combine their source arrays.
  const store = new zarr.FetchStore(source.url, {
    fetch: fetchGoogleObject,
  });

  return {
    dataset,
    source,
    role,
    variables,
    axes: {
      time: {
        id: "time",
        label: "Time",
        unit: "hours since 1900-01-01",
        kind: "time",
        values: Array.from(
          { length: maxTime - minTime + 1 },
          (_, index) => minTime + index,
        ),
      },
      level: {
        id: "level",
        label: "Pressure level",
        unit: "hPa",
        kind: "number",
        values: GOOGLE_LEVELS,
      },
    },
    store,
    layerOptions: {
      ...defaultLayerOptions(source),
      transformRequest: transformGoogleRequest,
    },
  };
}

const storeInfoPromises = new Map<string, Promise<StoreInfo>>();

export function loadStoreInfo(
  datasetId: string,
  role: DatasetSourceRole = "map",
  targetDate?: Date,
) {
  const dataset = getDataset(datasetId);
  const source = getDatasetSource(dataset, role);
  if (!source) {
    return Promise.reject(
      new Error(`This dataset does not define a ${role} store`),
    );
  }
  const targetKey = (
    source.kind === "weathernext" || source.kind === "weatherzarr"
  ) && targetDate
    ? `:${targetDate.toISOString().slice(0, 13)}`
    : "";
  const cacheKey = `${dataset.id}:${role}:${source.id}${targetKey}`;
  const cached = storeInfoPromises.get(cacheKey);
  if (cached) return cached;

  const promise = Promise.resolve(
    source.kind === "icechunk"
      ? loadIcechunkStoreInfo(dataset, source, role)
      : source.kind === "weatherzarr"
        ? loadWeatherZarrStoreInfo(dataset, source, role, targetDate)
        : source.kind === "weathernext"
          ? loadWeatherNextStoreInfo(dataset, source, role, targetDate)
        : dataset.id === "google-arco-era5"
          ? loadGoogleStoreInfo(dataset, source, role)
          : loadV3StoreInfo(dataset, source, role)
  ).then((info) => ({
    ...info,
    derivedVariables: derivedVariableMatches(info.variables),
  })).catch((error) => {
    storeInfoPromises.delete(cacheKey);
    throw error;
  });
  storeInfoPromises.set(cacheKey, promise);
  return promise;
}

export function defaultSelections(info: StoreInfo, variable: VariableConfig): AxisSelection {
  const selections: AxisSelection = {};
  const hasLeadAxis = variable.dimensions.some(
    (candidate) => info.axes[candidate]?.kind === "timedelta",
  );
  for (const dimension of variable.dimensions) {
    const axis = info.axes[dimension];
    if (!axis) continue;
    const historicalSeries = info.role === "series"
      && !hasLeadAxis;
    const forecastValidTime = info.dataset.category === "forecast"
      && axis.kind === "time"
      && (
        dimension.toLowerCase().includes("valid")
        || info.source.kind === "weathernext"
      )
      && !hasLeadAxis;
    selections[dimension] = axis.kind === "time"
      ? forecastValidTime
        ? 0
        : Math.max(
        0,
        axis.values.length - (historicalSeries ? SERIES_LOOKAHEAD_HOURS : 1),
      )
      : 0;
  }
  for (const axis of Object.values(info.axes)) {
    if (axis.requiresStoreReload) {
      selections[axis.id] = axis.defaultIndex ?? 0;
    }
  }
  return selections;
}

export function reconcileSelections(
  info: StoreInfo,
  variable: VariableConfig,
  current: AxisSelection,
) {
  const next = defaultSelections(info, variable);
  const selectableDimensions = new Set([
    ...variable.dimensions,
    ...Object.values(info.axes)
      .filter((axis) => axis.requiresStoreReload)
      .map((axis) => axis.id),
  ]);
  for (const dimension of selectableDimensions) {
    const axis = info.axes[dimension];
    const selected = current[dimension];
    if (!axis || selected === undefined) continue;
    next[dimension] = Math.max(0, Math.min(axis.values.length - 1, selected));
  }
  return next;
}

function temporalDimensions(info: StoreInfo, variable: VariableConfig) {
  const dimensions = [
    ...variable.dimensions,
    ...Object.values(info.axes)
      .filter((axis) => axis.requiresStoreReload)
      .map((axis) => axis.id),
  ];
  const time = dimensions.filter(
    (dimension) => info.axes[dimension]?.kind === "time",
  );
  const valid = time.find((dimension) =>
    dimension.toLowerCase().includes("valid"),
  );
  const initialization = valid
    ?? time.find((dimension) =>
      ["init_time", "forecast_reference_time", "forecast_date"].includes(
        dimension.toLowerCase(),
      ),
    )
    ?? time[0];
  const lead = dimensions.find(
    (dimension) => info.axes[dimension]?.kind === "timedelta",
  );
  return { valid, initialization, lead };
}

export function validDateRange(
  info: StoreInfo,
  variable: VariableConfig,
): { first: Date; last: Date } | undefined {
  const { valid, initialization, lead } = temporalDimensions(info, variable);
  if (!initialization) return undefined;
  const timeAxis = info.axes[initialization];
  if (!timeAxis?.values.length) return undefined;
  const endpointDates = [
    axisValueAsDate(info.dataset, timeAxis, 0).getTime(),
    axisValueAsDate(
      info.dataset,
      timeAxis,
      timeAxis.values.length - 1,
    ).getTime(),
  ];
  if (!endpointDates.every(Number.isFinite)) return undefined;
  let first = Math.min(...endpointDates);
  let last = Math.max(...endpointDates);
  if (!valid && lead) {
    const leadAxis = info.axes[lead];
    const leadOffsets = leadAxis.values.map((_, index) =>
      timedeltaMilliseconds(leadAxis, index)
    ).filter(Number.isFinite);
    if (leadOffsets.length) {
      first += Math.min(...leadOffsets);
      last += Math.max(...leadOffsets);
    }
  }
  return {
    first: new Date(first),
    last: new Date(last),
  };
}

export function selectedValidDate(
  info: StoreInfo,
  variable: VariableConfig,
  selections: AxisSelection,
) {
  const { valid, initialization, lead } = temporalDimensions(info, variable);
  if (!initialization) return undefined;
  const base = axisValueAsDate(
    info.dataset,
    info.axes[initialization],
    selections[initialization] ?? 0,
  );
  if (valid || !lead) return base;
  return new Date(
    base.getTime()
    + timedeltaMilliseconds(info.axes[lead], selections[lead] ?? 0),
  );
}

export function seriesStartDate(
  info: StoreInfo,
  variable: VariableConfig,
  selections: AxisSelection,
) {
  const { lead } = temporalDimensions(info, variable);
  return selectedValidDate(
    info,
    variable,
    lead ? { ...selections, [lead]: 0 } : selections,
  );
}

function latestTimeIndexAtOrBefore(
  info: StoreInfo,
  axis: AxisConfig,
  date: Date,
) {
  const match = axisDateMatch(info.dataset, axis, date);
  let index = match.index;
  if (match.date.getTime() > date.getTime()) {
    const ascending = match.first.getTime() <= match.last.getTime();
    index += ascending ? -1 : 1;
  }
  return Math.max(0, Math.min(axis.values.length - 1, index));
}

function nearestTimedeltaIndex(axis: AxisConfig, milliseconds: number) {
  let nearest = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < axis.values.length; index += 1) {
    const candidate = Math.abs(timedeltaMilliseconds(axis, index) - milliseconds);
    if (candidate < distance) {
      nearest = index;
      distance = candidate;
    }
  }
  return nearest;
}

function matchLeadToValidDate(
  info: StoreInfo,
  variable: VariableConfig,
  selections: AxisSelection,
  validDate: Date,
) {
  const { valid, initialization, lead } = temporalDimensions(info, variable);
  if (valid || !initialization || !lead) return selections;
  const initializationDate = axisValueAsDate(
    info.dataset,
    info.axes[initialization],
    selections[initialization] ?? 0,
  );
  return {
    ...selections,
    [lead]: nearestTimedeltaIndex(
      info.axes[lead],
      validDate.getTime() - initializationDate.getTime(),
    ),
  };
}

export function selectionsForValidDate(
  info: StoreInfo,
  variable: VariableConfig,
  validDate: Date,
  initial = defaultSelections(info, variable),
) {
  const next = { ...initial };
  const { valid, initialization } = temporalDimensions(info, variable);
  if (!initialization || !Number.isFinite(validDate.getTime())) return next;
  if (!info.axes[initialization].requiresStoreReload) {
    next[initialization] = valid
      ? axisIndexForDate(info.dataset, info.axes[initialization], validDate)
      : latestTimeIndexAtOrBefore(info, info.axes[initialization], validDate);
  }
  return matchLeadToValidDate(info, variable, next, validDate);
}

export function selectionsAfterAxisChange(
  info: StoreInfo,
  variable: VariableConfig,
  current: AxisSelection,
  axis: AxisConfig,
  nextIndex: number,
) {
  const validDate = selectedValidDate(info, variable, current);
  const next = { ...current, [axis.id]: nextIndex };
  return axis.kind === "time" && validDate
    ? matchLeadToValidDate(info, variable, next, validDate)
    : next;
}

export function selectorFor(
  variable: VariableConfig,
  selections: AxisSelection,
): Selector {
  const selector: Selector = {};
  for (const dimension of variable.dimensions) {
    if (dimension in selections) {
      selector[dimension] = { selected: selections[dimension], type: "index" };
    }
  }
  return selector;
}

function cfTimeOriginMilliseconds(origin: string) {
  const trimmed = origin.trim();
  const normalized = trimmed
    .replace(/\s+(UTC|GMT)$/i, "Z")
    .replace(/^(\d{4}-\d{2}-\d{2})\s+/, "$1T");
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return Date.parse(`${normalized}T00:00:00Z`);
  }
  const hasTimezone = (
    /Z$/i.test(normalized)
    || /[+-]\d{2}(?::?\d{2})?$/.test(normalized)
  );
  return Date.parse(hasTimezone ? normalized : `${normalized}Z`);
}

export function axisValueAsDate(dataset: DatasetConfig, axis: AxisConfig, index: number) {
  const value = Number(axis.values[index]);
  if (dataset.id === "google-arco-era5") {
    return new Date(GOOGLE_TIME_ORIGIN_MS + value * HOUR_MS);
  }
  const unit = axis.unit.toLowerCase();
  const multiplier = unit.startsWith("nanosecond") ? 1 / 1_000_000
    : unit.startsWith("microsecond") ? 1 / 1_000
      : unit.startsWith("millisecond") ? 1
        : unit.startsWith("minute") ? 60_000
          : unit.startsWith("hour") ? HOUR_MS
            : unit.startsWith("day") ? 24 * HOUR_MS
              : 1_000;
  const sinceMatch = axis.unit.match(/since\s+(.+)$/i);
  const origin = sinceMatch ? cfTimeOriginMilliseconds(sinceMatch[1]) : 0;
  return new Date(origin + value * multiplier);
}

export function axisDateInputValue(
  dataset: DatasetConfig,
  axis: AxisConfig,
  index: number,
) {
  const date = axisValueAsDate(dataset, axis, index);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 16);
}

export function axisIndexForDate(
  dataset: DatasetConfig,
  axis: AxisConfig,
  date: Date,
) {
  return axisDateMatch(dataset, axis, date).index;
}

export type AxisDateMatch = {
  index: number;
  date: Date;
  first: Date;
  last: Date;
  distanceMilliseconds: number;
};

export function axisDateMatch(
  dataset: DatasetConfig,
  axis: AxisConfig,
  date: Date,
): AxisDateMatch {
  const target = date.getTime();
  if (!Number.isFinite(target) || axis.values.length === 0) {
    const invalid = new Date(NaN);
    return {
      index: 0,
      date: invalid,
      first: invalid,
      last: invalid,
      distanceMilliseconds: Number.POSITIVE_INFINITY,
    };
  }
  let low = 0;
  let high = axis.values.length - 1;
  const first = axisValueAsDate(dataset, axis, low);
  const last = axisValueAsDate(dataset, axis, high);
  const ascending = first.getTime() <= last.getTime();

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const value = axisValueAsDate(dataset, axis, middle).getTime();
    const moveRight = ascending ? value < target : value > target;
    if (moveRight) low = middle + 1;
    else high = middle;
  }

  let index = low;
  if (low > 0) {
    const previous = low - 1;
    const currentDistance = Math.abs(
      axisValueAsDate(dataset, axis, low).getTime() - target,
    );
    const previousDistance = Math.abs(
      axisValueAsDate(dataset, axis, previous).getTime() - target,
    );
    index = currentDistance < previousDistance ? low : previous;
  }
  const matchedDate = axisValueAsDate(dataset, axis, index);
  return {
    index,
    date: matchedDate,
    first,
    last,
    distanceMilliseconds: Math.abs(matchedDate.getTime() - target),
  };
}

export function formatAxisValue(
  dataset: DatasetConfig,
  axis: AxisConfig,
  index: number,
) {
  const value = axis.values[index];
  if (axis.kind === "time") {
    const date = axisValueAsDate(dataset, axis, index);
    return Number.isNaN(date.getTime())
      ? String(value)
      : date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  }
  if (axis.kind === "timedelta") {
    const numeric = Number(value);
    const seconds = axis.unit.toLowerCase().startsWith("hour")
      ? numeric * 3600
      : axis.unit.toLowerCase().startsWith("day")
        ? numeric * 86400
        : numeric;
    const hours = seconds / 3600;
    return Number.isInteger(hours) ? `+${hours} h` : `+${hours.toFixed(1)} h`;
  }
  return `${value}${axis.unit ? ` ${axis.unit}` : ""}`;
}

export function toDataCoordinates(
  dataset: DatasetConfig,
  longitude: number,
  latitude: number,
): [number, number] {
  const source = getDatasetSource(dataset, "map");
  if (
    source?.crs === "EPSG:4326"
    && source.bounds
    && source.bounds[0] >= 0
    && source.bounds[2] > 180
  ) {
    return [((longitude % 360) + 360) % 360, latitude];
  }
  return [longitude, latitude];
}

function nearestCoordinateIndex(values: ArrayLike<number>, target: number) {
  let low = 0;
  let high = values.length - 1;
  const ascending = values[0] <= values[high];
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const moveRight = ascending
      ? values[middle] < target
      : values[middle] > target;
    if (moveRight) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return 0;
  const previous = low - 1;
  return Math.abs(values[low] - target) < Math.abs(values[previous] - target)
    ? low
    : previous;
}

function nearestLongitudeIndex(values: ArrayLike<number>, target: number) {
  let nearestIndex = 0;
  let nearestDistance = Infinity;
  for (let index = 0; index < values.length; index += 1) {
    const difference = ((Number(values[index]) - target + 540) % 360) - 180;
    const distance = Math.abs(difference);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }
  return nearestIndex;
}

function spatialDimension(
  info: StoreInfo,
  variable: VariableConfig,
  axis: "lat" | "lon",
) {
  const configured = info.source.spatialDimensions?.[axis];
  if (configured && variable.dimensions.includes(configured)) return configured;
  const aliases = axis === "lat"
    ? ["latitude", "lat", "y"]
    : ["longitude", "lon", "x"];
  return variable.dimensions.find((dimension) =>
    aliases.includes(dimension.toLowerCase()),
  );
}

function pointInSourceCoordinates(
  source: DatasetSourceConfig,
  longitude: number,
  latitude: number,
  xValues: ArrayLike<number>,
) {
  if (source.proj4) {
    const [x, y] = proj4("EPSG:4326", source.proj4, [longitude, latitude]);
    return [x, y] as const;
  }
  const x = xValues[0] >= 0
    ? ((longitude % 360) + 360) % 360
    : longitude;
  return [x, latitude] as const;
}

async function pointSpatialSelection(
  info: StoreInfo,
  variable: VariableConfig,
  longitude: number,
  latitude: number,
  options: PointSeriesLoadOptions = {},
) {
  if (!info.store) return null;
  const latitudeDimension = spatialDimension(info, variable, "lat");
  const longitudeDimension = spatialDimension(info, variable, "lon");
  if (!latitudeDimension || !longitudeDimension) return null;

  const root = zarr.root(info.store);
  const [latitudeArray, longitudeArray] = await Promise.all([
    zarr.open(root.resolve(latitudeDimension), { kind: "array" }),
    zarr.open(root.resolve(longitudeDimension), { kind: "array" }),
  ]);
  const [latitudeData, longitudeData] = await Promise.all([
    zarr.get(latitudeArray, null, zarrReadOptions(options)),
    zarr.get(longitudeArray, null, zarrReadOptions(options)),
  ]);
  const latitudeValues = Array.from(
    latitudeData.data as ArrayLike<number | bigint>,
    Number,
  );
  const longitudeValues = Array.from(
    longitudeData.data as ArrayLike<number | bigint>,
    Number,
  );
  const [sourceLongitude, sourceLatitude] = pointInSourceCoordinates(
    info.source,
    longitude,
    latitude,
    longitudeValues,
  );
  return {
    latitudeDimension,
    longitudeDimension,
    latitudeIndex: nearestCoordinateIndex(latitudeValues, sourceLatitude),
    longitudeIndex: info.source.proj4
      ? nearestCoordinateIndex(longitudeValues, sourceLongitude)
      : nearestLongitudeIndex(longitudeValues, sourceLongitude),
  };
}

export type PointSeriesLoadOptions = {
  signal?: AbortSignal;
  concurrency?: number;
};

function zarrReadOptions(options: PointSeriesLoadOptions) {
  return {
    signal: options.signal,
    createQueue: () => createBoundedAsyncQueue(
      options.concurrency ?? SERIES_CHUNK_CONCURRENCY,
    ),
  };
}

export async function loadPointTimeSeries(
  info: StoreInfo,
  variable: VariableConfig,
  selections: AxisSelection,
  longitude: number,
  latitude: number,
  options: PointSeriesLoadOptions = {},
): Promise<PointTimeSeries | null> {
  if (info.role !== "series" || !info.store) return null;
  const timeDimension = variable.dimensions.find(
    (dimension) => info.axes[dimension]?.kind === "time",
  );
  if (!timeDimension) return null;
  const spatial = await pointSpatialSelection(
    info,
    variable,
    longitude,
    latitude,
    options,
  );
  if (!spatial) return null;
  const {
    latitudeDimension,
    longitudeDimension,
    latitudeIndex,
    longitudeIndex,
  } = spatial;
  const dataArray = await zarr.open(
    zarr.root(info.store).resolve(variable.id),
    { kind: "array" },
  );
  const timeAxis = info.axes[timeDimension];
  const start = selections[timeDimension] ?? 0;
  const stop = Math.min(timeAxis.values.length, start + SERIES_LOOKAHEAD_HOURS);
  const request = variable.dimensions.map((dimension) => {
    if (dimension === timeDimension) return zarr.slice(start, stop);
    if (dimension === latitudeDimension) return latitudeIndex;
    if (dimension === longitudeDimension) return longitudeIndex;
    return selections[dimension] ?? 0;
  });
  const result = await zarr.get(dataArray, request, zarrReadOptions(options));
  const values = Array.from(result.data as ArrayLike<number | bigint>, Number);
  return {
    kind: "history",
    values,
    dates: Array.from(
      { length: values.length },
      (_, offset) => axisValueAsDate(info.dataset, timeAxis, start + offset),
    ),
    unit: variable.unit,
    variableLabel: variable.label,
    latitude,
    longitude,
  };
}

function quantile(sorted: number[], probability: number) {
  if (!sorted.length) return NaN;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

type RawPointForecast = {
  values: Float64Array;
  dates: Date[];
  leadCount: number;
  memberCount: number;
  latitude: number;
  longitude: number;
};

export function timedeltaMilliseconds(axis: AxisConfig, index: number) {
  const value = Number(axis.values[index]);
  const unit = axis.unit.toLowerCase();
  if (unit.startsWith("nanosecond")) return value / 1_000_000;
  if (unit.startsWith("microsecond")) return value / 1_000;
  if (unit.startsWith("day")) return value * 86_400_000;
  if (unit.startsWith("hour")) return value * HOUR_MS;
  if (unit.startsWith("minute")) return value * 60_000;
  if (unit.startsWith("millisecond")) return value;
  return value * 1_000;
}

async function loadRawPointForecast(
  info: StoreInfo,
  variable: VariableConfig,
  selections: AxisSelection,
  longitude: number,
  latitude: number,
  options: PointSeriesLoadOptions = {},
): Promise<RawPointForecast | null> {
  if (info.role !== "series" || !info.store) return null;
  const initDimension = [
    ...variable.dimensions,
    ...Object.values(info.axes)
      .filter((axis) => axis.requiresStoreReload)
      .map((axis) => axis.id),
  ].find(
    (dimension) =>
      info.axes[dimension]?.kind === "time"
      && ["init_time", "forecast_reference_time", "forecast_date"].includes(
        dimension.toLowerCase(),
      ),
  );
  const leadDimension = variable.dimensions.find(
    (dimension) => info.axes[dimension]?.kind === "timedelta",
  );
  const memberDimension = variable.dimensions.find((dimension) =>
    ["ensemble_member", "ensemble", "member", "sample", "number"].includes(
      dimension.toLowerCase(),
    ),
  );
  if (!initDimension || !leadDimension) {
    return null;
  }

  const spatial = await pointSpatialSelection(
    info,
    variable,
    longitude,
    latitude,
    options,
  );
  if (!spatial) return null;
  const {
    latitudeDimension,
    longitudeDimension,
    latitudeIndex,
    longitudeIndex,
  } = spatial;
  const dataArray = await zarr.open(
    zarr.root(info.store).resolve(variable.id),
    { kind: "array" },
  );
  const leadAxis = info.axes[leadDimension];
  const initAxis = info.axes[initDimension];
  const memberCount = memberDimension
    ? info.axes[memberDimension]?.values.length ?? 1
    : 1;
  const leadCount = Math.max(
    1,
    leadAxis.values.findLastIndex(
      (_, index) => timedeltaMilliseconds(leadAxis, index) <= SERIES_LOOKAHEAD_MS,
    ) + 1,
  );
  const request = variable.dimensions.map((dimension) => {
    if (dimension === leadDimension) return zarr.slice(0, leadCount);
    if (dimension === memberDimension) return zarr.slice(0, memberCount);
    if (dimension === latitudeDimension) return latitudeIndex;
    if (dimension === longitudeDimension) return longitudeIndex;
    return selections[dimension] ?? 0;
  });
  const result = await zarr.get(dataArray, request, zarrReadOptions(options));
  const remainingDimensions = variable.dimensions.filter(
    (dimension) => dimension === leadDimension || dimension === memberDimension,
  );
  const leadPosition = remainingDimensions.indexOf(leadDimension);
  const memberPosition = memberDimension
    ? remainingDimensions.indexOf(memberDimension)
    : -1;
  const sourceValues = result.data as ArrayLike<number | bigint>;
  const values = new Float64Array(leadCount * memberCount);
  for (let leadIndex = 0; leadIndex < leadCount; leadIndex += 1) {
    for (let memberIndex = 0; memberIndex < memberCount; memberIndex += 1) {
      let offset = leadIndex * result.stride[leadPosition];
      if (memberPosition >= 0) {
        offset += memberIndex * result.stride[memberPosition];
      }
      values[leadIndex * memberCount + memberIndex] = Number(
        sourceValues[offset],
      );
    }
  }
  const initDate = axisValueAsDate(
    info.dataset,
    initAxis,
    selections[initDimension] ?? 0,
  );
  return {
    values,
    dates: leadAxis.values.slice(0, leadCount).map(
      (_, index) => new Date(
        initDate.getTime() + timedeltaMilliseconds(leadAxis, index),
      ),
    ),
    leadCount,
    memberCount,
    latitude,
    longitude,
  };
}

function pointForecastFromRaw(
  raw: RawPointForecast,
  variable: VariableConfig,
  values: ArrayLike<number | bigint>,
  unit = variable.unit,
): PointForecastSeries {
  const allQuantiles = Array.from(
    { length: raw.leadCount },
    (_, leadIndex) => {
      const members = Array.from(
        { length: raw.memberCount },
        (_, memberIndex) => Number(
          values[leadIndex * raw.memberCount + memberIndex],
        ),
      ).filter(Number.isFinite).sort((a, b) => a - b);
      return {
      min: members[0] ?? NaN,
      q10: quantile(members, 0.1),
      q25: quantile(members, 0.25),
      q50: quantile(members, 0.5),
      q75: quantile(members, 0.75),
      q90: quantile(members, 0.9),
      max: members.at(-1) ?? NaN,
      };
    },
  );
  const lastFiniteIndex = allQuantiles.findLastIndex((item) =>
    Number.isFinite(item.q50),
  );
  const quantiles = allQuantiles.slice(0, Math.max(1, lastFiniteIndex + 1));
  return {
    kind: "forecast",
    quantiles,
    dates: raw.dates.slice(0, quantiles.length),
    unit,
    variableLabel: variable.label,
    latitude: raw.latitude,
    longitude: raw.longitude,
    memberCount: raw.memberCount,
  };
}

export async function loadPointForecast(
  info: StoreInfo,
  variable: VariableConfig,
  selections: AxisSelection,
  longitude: number,
  latitude: number,
  options: PointSeriesLoadOptions = {},
): Promise<PointForecastSeries | null> {
  const raw = await loadRawPointForecast(
    info,
    variable,
    selections,
    longitude,
    latitude,
    options,
  );
  return raw
    ? pointForecastFromRaw(raw, variable, raw.values)
    : null;
}

function sameDates(first: Date[], second: Date[]) {
  return first.length === second.length
    && first.every(
      (date, index) => date.getTime() === second[index]?.getTime(),
    );
}

async function loadDerivedPointTimeSeries(
  info: StoreInfo,
  variable: VariableConfig,
  selections: AxisSelection,
  longitude: number,
  latitude: number,
  options: PointSeriesLoadOptions,
): Promise<PointTimeSeries | null> {
  const inputs = nativeInputsForDerived(variable, info.variables);
  const loaded = await Promise.all(inputs.map(
    ({ variable: input }) => loadPointTimeSeries(
      info,
      input,
      selections,
      longitude,
      latitude,
      options,
    ),
  ));
  const first = loaded[0];
  if (
    !first
    || loaded.some((series) => !series || !sameDates(first.dates, series.dates))
  ) return null;
  const derived = executeDerivedPipeline(
    variable,
    info.variables,
    Object.fromEntries(inputs.map(({ key }, index) => [
      key,
      loaded[index]?.values ?? [],
    ])),
  );
  return {
    ...first,
    values: Array.from(derived.values),
    unit: derived.unit,
    variableLabel: variable.label,
  };
}

async function loadDerivedPointForecast(
  info: StoreInfo,
  variable: VariableConfig,
  selections: AxisSelection,
  longitude: number,
  latitude: number,
  options: PointSeriesLoadOptions,
): Promise<PointForecastSeries | null> {
  const inputs = nativeInputsForDerived(variable, info.variables);
  const loaded = await Promise.all(inputs.map(
    ({ variable: input }) => loadRawPointForecast(
      info,
      input,
      selections,
      longitude,
      latitude,
      options,
    ),
  ));
  const first = loaded[0];
  if (
    !first
    || loaded.some((series) => (
      !series
      || series.memberCount !== first.memberCount
      || !sameDates(first.dates, series.dates)
    ))
  ) return null;
  const derived = executeDerivedPipeline(
    variable,
    info.variables,
    Object.fromEntries(inputs.map(({ key }, index) => [
      key,
      loaded[index]?.values ?? [],
    ])),
  );
  return pointForecastFromRaw(
    first,
    variable,
    derived.values,
    derived.unit,
  );
}

export function isForecastSeries(
  info: StoreInfo,
  variable: VariableConfig,
) {
  return variable.dimensions.some(
    (dimension) => info.axes[dimension]?.kind === "timedelta",
  );
}

export function loadPointSeries(
  info: StoreInfo,
  variable: VariableConfig,
  selections: AxisSelection,
  longitude: number,
  latitude: number,
  options: PointSeriesLoadOptions = {},
) {
  if (variable.derived) {
    return isForecastSeries(info, variable)
      ? loadDerivedPointForecast(
        info,
        variable,
        selections,
        longitude,
        latitude,
        options,
      )
      : loadDerivedPointTimeSeries(
        info,
        variable,
        selections,
        longitude,
        latitude,
        options,
      );
  }
  return isForecastSeries(info, variable)
    ? loadPointForecast(info, variable, selections, longitude, latitude, options)
    : loadPointTimeSeries(info, variable, selections, longitude, latitude, options);
}

export { transformGoogleRequest };
