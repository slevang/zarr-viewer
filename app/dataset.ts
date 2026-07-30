import { IcechunkStore } from "icechunk-js";
import * as zarr from "zarrita";
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
import type {
  AxisConfig,
  AxisKind,
  StoreInfo,
  VariableConfig,
} from "./data/types";
import {
  hasSpatialDimensions,
  isInitializationDimension,
  isSpatialDimension,
  isValidTimeDimension,
} from "./data/dimensions";
import { registerFixedScaleOffset } from "./codecs/fixedscaleoffset";
import { registerGribberishCodec } from "./codecs/gribberish";
import { registerPcodec } from "./codecs/pcodec";
import {
  derivedVariableMatches,
} from "./derived-variables";
import {
  googleAuthorizedFetch,
} from "./google-auth";
import {
  ecmwfAuthorizedFetch,
} from "./ecmwf-auth";

export type {
  AxisConfig,
  AxisKind,
  AxisSelection,
  DerivedTransformConfig,
  DerivedVariableSpec,
  ForecastQuantiles,
  PointForecastSeries,
  PointSeries,
  PointSeriesLoadOptions,
  PointTimeSeries,
  StoreInfo,
  VariableConfig,
} from "./data/types";
export * from "./data/axes";
export * from "./data/point-series";

registerGribberishCodec();
registerFixedScaleOffset();
registerPcodec();

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

const GOOGLE_TIME_ORIGIN_MS = Date.UTC(1900, 0, 1);
const HOUR_MS = 60 * 60 * 1000;
const STORE_READ_CONCURRENCY = 32;
const STORE_READ_CACHE_BYTES = 1024 * 1024 * 1024;
const GOOGLE_FETCH_ATTEMPTS = 3;
const GOOGLE_LEVELS = [
  1, 2, 3, 5, 7, 10, 20, 30, 50, 70, 100, 125, 150, 175, 200, 225,
  250, 300, 350, 400, 450, 500, 550, 600, 650, 700, 750, 775, 800, 825,
  850, 875, 900, 925, 950, 975, 1000,
];
const storeReadCache = new Map<string, Uint8Array>();
let storeReadCacheBytes = 0;
let nextStoreCacheId = 1;

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
    || isInitializationDimension(name)
    || isValidTimeDimension(name)
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

function recordDimensionLengths(
  lengths: Map<string, number>,
  dimensions: string[],
  shape: number[] | undefined,
  source: DatasetSourceConfig,
) {
  dimensions.forEach((dimension, index) => {
    if (isSpatialDimension(dimension, source)) return;
    lengths.set(
      dimension,
      Math.max(lengths.get(dimension) ?? 0, shape?.[index] ?? 0),
    );
  });
}

function cacheStoreReads(
  store: Readable,
  limit = STORE_READ_CONCURRENCY,
): Readable {
  let active = 0;
  const queue: Array<() => void> = [];
  const pending = new Map<string, Promise<Uint8Array | undefined>>();
  const namespace = `store-${nextStoreCacheId}`;
  nextStoreCacheId += 1;

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
    if (value.byteLength > STORE_READ_CACHE_BYTES) return;
    const existing = storeReadCache.get(key);
    if (existing) storeReadCacheBytes -= existing.byteLength;
    storeReadCache.delete(key);
    storeReadCache.set(key, value);
    storeReadCacheBytes += value.byteLength;
    while (storeReadCacheBytes > STORE_READ_CACHE_BYTES) {
      const oldestKey = storeReadCache.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = storeReadCache.get(oldestKey);
      storeReadCache.delete(oldestKey);
      storeReadCacheBytes -= oldest?.byteLength ?? 0;
    }
  };

  const read = (
    cacheKey: string,
    task: () => Promise<Uint8Array | undefined>,
  ) => {
    const namespacedKey = `${namespace}:${cacheKey}`;
    const cached = storeReadCache.get(namespacedKey);
    if (cached) {
      storeReadCache.delete(namespacedKey);
      storeReadCache.set(namespacedKey, cached);
      return Promise.resolve(cached);
    }
    const inProgress = pending.get(namespacedKey);
    if (inProgress) return inProgress;
    const promise = schedule(task).then((value) => {
      if (value) remember(namespacedKey, value);
      return value;
    }).finally(() => {
      pending.delete(namespacedKey);
    });
    pending.set(namespacedKey, promise);
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
    if (!hasSpatialDimensions(dimensions, source)) continue;

    recordDimensionLengths(
      dimensionLengths,
      dimensions,
      metadata.shape,
      source,
    );

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
    if (!hasSpatialDimensions(dimensions, source)) continue;

    recordDimensionLengths(
      dimensionLengths,
      dimensions,
      arrayMetadata.shape,
      source,
    );

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

type ConsolidatedReadable = Readable & {
  contents: () => Array<{
    path: AbsolutePath;
    kind: "array" | "group";
  }>;
};

async function variablesFromConsolidatedStore(
  store: ConsolidatedReadable,
  source: DatasetSourceConfig,
) {
  const variables: VariableConfig[] = [];
  const dimensionLengths = new Map<string, number>();

  await Promise.all(store.contents().map(async (entry) => {
    const id = entry.path.replace(/^\/+/, "");
    if (entry.kind !== "array" || !id || id.includes("/")) return;
    const array = await zarr.open(zarr.root(store).resolve(id), {
      kind: "array",
    });
    const dimensions = array.dimensionNames ?? [];
    if (!hasSpatialDimensions(dimensions, source)) return;
    recordDimensionLengths(dimensionLengths, dimensions, array.shape, source);
    const attrs = array.attrs as Record<string, unknown>;
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
      dimensions,
      shape: array.shape,
      chunkShape: array.chunks,
      dataType: array.dtype,
    });
  }));

  variables.sort((first, second) =>
    first.label.localeCompare(second.label, undefined, { sensitivity: "base" })
  );
  return { variables, dimensionLengths };
}

async function readConsolidatedCoordinate(
  store: ConsolidatedReadable,
  dimension: string,
  expectedLength: number,
): Promise<AxisConfig> {
  const array = await zarr.open(zarr.root(store).resolve(dimension), {
    kind: "array",
  });
  const attrs = array.attrs as Record<string, unknown>;
  const values = product(array.shape) <= 1_000_000
    ? Array.from(
      (await zarr.get(array)).data as ArrayLike<unknown>,
      normalizeValue,
    )
    : Array.from({ length: expectedLength }, (_, index) => index);
  return {
    id: dimension,
    label: axisLabel(dimension, attrs),
    unit: typeof attrs.units === "string" ? attrs.units : "",
    kind: axisKind(dimension, attrs, array.dtype),
    values,
  };
}

async function loadEcmwfArcoStoreInfo(
  dataset: DatasetConfig,
  source: DatasetSourceConfig,
  role: DatasetSourceRole,
): Promise<StoreInfo> {
  const rawStore = new zarr.FetchStore(source.url, {
    fetch: ecmwfAuthorizedFetch,
  });
  const consolidatedStore = await zarr.withConsolidatedMetadata(rawStore, {
    format: "v2",
  }) as ConsolidatedReadable;
  const { variables, dimensionLengths } = await variablesFromConsolidatedStore(
    consolidatedStore,
    source,
  );
  if (!variables.length) {
    throw new Error("ECMWF ARCO did not report any compatible spatial variables");
  }
  const axes: Record<string, AxisConfig> = {};
  await Promise.all(Array.from(dimensionLengths, async ([dimension, length]) => {
    axes[dimension] = await readConsolidatedCoordinate(
      consolidatedStore,
      dimension,
      length,
    );
  }));
  const cachedStore = cacheStoreReads(consolidatedStore);
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
    if (!hasSpatialDimensions(typedDimensions, source)) continue;

    const arrayMetadata = metadata[`${id}/.zarray`] as
      | ZarrV2ArrayMetadata
      | undefined;
    const shape = numericArray(arrayMetadata?.shape);
    recordDimensionLengths(
      dimensionLengths,
      typedDimensions,
      shape,
      source,
    );
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
  const layout = source.layout ?? "timeseries";
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

type StoreInfoLoader = (
  dataset: DatasetConfig,
  source: DatasetSourceConfig,
  role: DatasetSourceRole,
  targetDate?: Date,
) => Promise<StoreInfo>;

const STORE_INFO_LOADERS = {
  zarr: loadV3StoreInfo,
  icechunk: loadIcechunkStoreInfo,
  weatherzarr: loadWeatherZarrStoreInfo,
  weathernext: loadWeatherNextStoreInfo,
  "google-arco": loadGoogleStoreInfo,
  "ecmwf-arco": loadEcmwfArcoStoreInfo,
} satisfies Record<DatasetSourceConfig["kind"], StoreInfoLoader>;

const sourceInfoPromises = new Map<string, Promise<StoreInfo>>();
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
  const sourceKey = [
    dataset.id,
    source.id,
    source.url,
    source.group ?? "",
    source.layout ?? "",
    targetKey,
  ].join(":");
  const requestKey = `${sourceKey}:${role}`;
  const cached = storeInfoPromises.get(requestKey);
  if (cached) return cached;

  let sourcePromise = sourceInfoPromises.get(sourceKey);
  if (!sourcePromise) {
    sourcePromise = STORE_INFO_LOADERS[source.kind](
      dataset,
      source,
      role,
      targetDate,
    ).then((info) => ({
      ...info,
      derivedVariables: derivedVariableMatches(info.variables),
    })).catch((error) => {
      sourceInfoPromises.delete(sourceKey);
      throw error;
    });
    sourceInfoPromises.set(sourceKey, sourcePromise);
  }

  const promise = sourcePromise.then((info) =>
    info.role === role ? info : { ...info, role }
  ).catch((error) => {
    storeInfoPromises.delete(requestKey);
    throw error;
  });
  storeInfoPromises.set(requestKey, promise);
  return promise;
}


export { transformGoogleRequest };
