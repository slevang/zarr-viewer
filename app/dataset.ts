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
import { registerGribberishCodec } from "./codecs/gribberish";
import { registerPcodec } from "./codecs/pcodec";
import {
  derivedVariableMatches,
} from "./derived-variables";
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
const stacAssetPromises = new Map<string, Promise<string>>();

function product(values: number[]) {
  return values.reduce((result, value) => result * value, 1);
}

function normalizeValue(value: unknown): number | string {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" || typeof value === "string") return value;
  return String(value);
}

function scalarNumber(result: unknown) {
  const data = result && typeof result === "object" && "data" in result
    ? result.data
    : result;
  return Array.isArray(data) || ArrayBuffer.isView(data)
    ? Number((data as ArrayLike<number | bigint>)[0])
    : Number(data);
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

function metadataUnit(
  attrs: Record<string, unknown>,
) {
  const entry = Object.entries(attrs).find(([key, value]) =>
    ["unit", "units"].includes(key.toLowerCase())
    && typeof value === "string"
  );
  return entry && typeof entry[1] === "string" ? entry[1] : "";
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
  const resolvedUrl = source.stacCollectionId
    ? await resolveStacAsset(source)
    : source.url;
  const resolvedSource = resolvedUrl === source.url
    ? source
    : { ...source, url: resolvedUrl };
  const repository = await IcechunkStore.open(resolvedUrl);
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
    source: resolvedSource,
    role,
    variables,
    axes,
    store: cachedStore,
    layerOptions: defaultLayerOptions(source, cachedStore),
  };
}

type StacCollection = {
  assets?: Record<string, { href?: unknown }>;
};

async function resolveStacAsset(source: DatasetSourceConfig) {
  const collectionId = source.stacCollectionId;
  if (!collectionId) return source.url;
  const assetName = source.stacAsset ?? "icechunk-https";
  const key = `${collectionId}:${assetName}`;
  const cached = stacAssetPromises.get(key);
  if (cached) return cached;
  const promise = fetch(
    `https://stac.dynamical.org/${encodeURIComponent(collectionId)}/collection.json`,
  ).then(async (response) => {
    if (!response.ok) {
      throw new Error(`Dynamical STAC request failed (${response.status})`);
    }
    const collection = await response.json() as StacCollection;
    const href = collection.assets?.[assetName]?.href;
    if (typeof href !== "string" || !href) {
      throw new Error(
        `Dynamical STAC collection ${collectionId} has no ${assetName} asset`,
      );
    }
    return href.replace(/\/$/, "");
  }).catch((error) => {
    stacAssetPromises.delete(key);
    // The public STAC endpoint is not consistently CORS-enabled. Catalog
    // entries retain a verified HTTPS fallback so browser loads remain
    // anonymous and do not depend on a metadata-sidecar request succeeding.
    if (!(error instanceof TypeError)) {
      console.warn(`Dynamical STAC unavailable for ${collectionId}; using pinned asset`, error);
    }
    return source.url;
  });
  stacAssetPromises.set(key, promise);
  return promise;
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
      unit: metadataUnit(attrs),
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
  const timeMetadata = consolidated.metadata?.["time/.zarray"];
  const timeShape = Array.isArray(timeMetadata?.shape)
    ? timeMetadata.shape
    : [];
  const physicalTimeLength = timeShape.length === 1
    && typeof timeShape[0] === "number"
    ? timeShape[0]
    : undefined;
  if (
    physicalTimeLength === undefined
    || !Number.isInteger(physicalTimeLength)
    || minTime < 0
    || maxTime < minTime
    || maxTime >= physicalTimeLength
  ) {
    throw new Error("Google ARCO time availability does not fit its physical time array");
  }
  const store = new zarr.FetchStore(source.url, {
    fetch: fetchGoogleObject,
  });
  const timeArray = await zarr.open(
    zarr.root(store).resolve("time"),
    { kind: "array" },
  );
  const [firstPhysicalTime, lastPhysicalTime] = await Promise.all([
    zarr.get(timeArray, [minTime]).then(scalarNumber),
    zarr.get(timeArray, [maxTime]).then(scalarNumber),
  ]);
  if (firstPhysicalTime !== minTime || lastPhysicalTime !== maxTime) {
    throw new Error(
      `Google ARCO time offset mismatch: expected ${minTime}…${maxTime}, received ${firstPhysicalTime}…${lastPhysicalTime}`,
    );
  }
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
        storageIndexOffset: minTime,
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
) => Promise<StoreInfo>;

const STORE_INFO_LOADERS = {
  icechunk: loadIcechunkStoreInfo,
  "google-arco": loadGoogleStoreInfo,
  "ecmwf-arco": loadEcmwfArcoStoreInfo,
} satisfies Record<DatasetSourceConfig["kind"], StoreInfoLoader>;

const sourceInfoPromises = new Map<string, Promise<StoreInfo>>();
const storeInfoPromises = new Map<string, Promise<StoreInfo>>();

export function loadStoreInfo(
  datasetId: string,
  role: DatasetSourceRole = "map",
  _targetDate?: Date,
) {
  void _targetDate;
  const dataset = getDataset(datasetId);
  const source = getDatasetSource(dataset, role);
  if (!source) {
    return Promise.reject(
      new Error(`This dataset does not define a ${role} store`),
    );
  }
  const sourceKey = [
    dataset.id,
    source.id,
    source.url,
    source.stacCollectionId ?? "",
    source.stacAsset ?? "",
    source.group ?? "",
    source.layout ?? "",
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
