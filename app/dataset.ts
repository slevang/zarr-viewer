import { IcechunkStore } from "icechunk-js";
import proj4 from "proj4";
import * as zarr from "zarrita";
import type { Selector, TransformRequest } from "@carbonplan/zarr-layer";
import type { Readable } from "zarrita";
import {
  getDataset,
  getDatasetSource,
  type DatasetConfig,
  type DatasetSourceConfig,
  type DatasetSourceRole,
} from "./catalog";
import { createBoundedAsyncQueue } from "./async-queue";
import { registerGribberishCodec } from "./codecs/gribberish";
import { registerPcodec } from "./codecs/pcodec";

registerGribberishCodec();
registerPcodec();

export type AxisKind = "time" | "timedelta" | "number" | "category";

export type AxisConfig = {
  id: string;
  label: string;
  unit: string;
  kind: AxisKind;
  values: Array<number | string>;
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
};

export type StoreInfo = {
  dataset: DatasetConfig;
  source: DatasetSourceConfig;
  role: DatasetSourceRole;
  variables: VariableConfig[];
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
  store: IcechunkStore,
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

  const cachedGet: IcechunkStore["get"] = (...args) =>
    read(`get:${args[0]}`, () => store.get(...args));
  const cachedGetRange: IcechunkStore["getRange"] = (...args) =>
    read(`range:${args[0]}:${JSON.stringify(args[1])}`, () => store.getRange(...args));

  return new Proxy(store, {
    get(target, property) {
      if (property === "get") return cachedGet;
      if (property === "getRange") return cachedGetRange;
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

  const store = role === "series"
    ? new zarr.FetchStore(source.url, {
      fetch: fetchGoogleObject,
    })
    : undefined;

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
) {
  const dataset = getDataset(datasetId);
  const source = getDatasetSource(dataset, role);
  if (!source) {
    return Promise.reject(
      new Error(`This dataset does not define a ${role} store`),
    );
  }
  const cacheKey = `${dataset.id}:${role}:${source.id}`;
  const cached = storeInfoPromises.get(cacheKey);
  if (cached) return cached;

  const promise = (
    source.kind === "icechunk"
      ? loadIcechunkStoreInfo(dataset, source, role)
      : loadGoogleStoreInfo(dataset, source, role)
  ).catch((error) => {
    storeInfoPromises.delete(cacheKey);
    throw error;
  });
  storeInfoPromises.set(cacheKey, promise);
  return promise;
}

export function defaultSelections(info: StoreInfo, variable: VariableConfig): AxisSelection {
  const selections: AxisSelection = {};
  for (const dimension of variable.dimensions) {
    const axis = info.axes[dimension];
    if (!axis) continue;
    const historicalSeries = info.role === "series"
      && !variable.dimensions.some(
        (candidate) => info.axes[candidate]?.kind === "timedelta",
      );
    selections[dimension] = axis.kind === "time"
      ? Math.max(
        0,
        axis.values.length - (historicalSeries ? SERIES_LOOKAHEAD_HOURS : 1),
      )
      : 0;
  }
  return selections;
}

export function reconcileSelections(
  info: StoreInfo,
  variable: VariableConfig,
  current: AxisSelection,
) {
  const next = defaultSelections(info, variable);
  for (const dimension of variable.dimensions) {
    const axis = info.axes[dimension];
    const selected = current[dimension];
    if (!axis || selected === undefined) continue;
    next[dimension] = Math.max(0, Math.min(axis.values.length - 1, selected));
  }
  return next;
}

function temporalDimensions(info: StoreInfo, variable: VariableConfig) {
  const time = variable.dimensions.filter(
    (dimension) => info.axes[dimension]?.kind === "time",
  );
  const valid = time.find((dimension) =>
    dimension.toLowerCase().includes("valid"),
  );
  const initialization = valid
    ?? time.find((dimension) =>
      ["init_time", "forecast_reference_time"].includes(dimension.toLowerCase()),
    )
    ?? time[0];
  const lead = variable.dimensions.find(
    (dimension) => info.axes[dimension]?.kind === "timedelta",
  );
  return { valid, initialization, lead };
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
  next[initialization] = valid
    ? axisIndexForDate(info.dataset, info.axes[initialization], validDate)
    : latestTimeIndexAtOrBefore(info, info.axes[initialization], validDate);
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
  if (dataset.id === "google-arco-era5") {
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
    longitudeIndex: nearestCoordinateIndex(longitudeValues, sourceLongitude),
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

export async function loadPointForecast(
  info: StoreInfo,
  variable: VariableConfig,
  selections: AxisSelection,
  longitude: number,
  latitude: number,
  options: PointSeriesLoadOptions = {},
): Promise<PointForecastSeries | null> {
  if (info.role !== "series" || !info.store) return null;
  const initDimension = variable.dimensions.find(
    (dimension) =>
      info.axes[dimension]?.kind === "time"
      && ["init_time", "forecast_reference_time"].includes(dimension.toLowerCase()),
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
  const values = result.data as ArrayLike<number | bigint>;
  const allQuantiles = Array.from({ length: leadCount }, (_, leadIndex) => {
    const members = Array.from({ length: memberCount }, (_, memberIndex) => {
      let offset = leadIndex * result.stride[leadPosition];
      if (memberPosition >= 0) {
        offset += memberIndex * result.stride[memberPosition];
      }
      return Number(values[offset]);
    }).filter(Number.isFinite).sort((a, b) => a - b);
    return {
      min: members[0] ?? NaN,
      q10: quantile(members, 0.1),
      q25: quantile(members, 0.25),
      q50: quantile(members, 0.5),
      q75: quantile(members, 0.75),
      q90: quantile(members, 0.9),
      max: members.at(-1) ?? NaN,
    };
  });
  const initDate = axisValueAsDate(
    info.dataset,
    initAxis,
    selections[initDimension] ?? 0,
  );
  const lastFiniteIndex = allQuantiles.findLastIndex((item) =>
    Number.isFinite(item.q50),
  );
  const quantiles = allQuantiles.slice(0, Math.max(1, lastFiniteIndex + 1));
  return {
    kind: "forecast",
    quantiles,
    dates: leadAxis.values.slice(0, quantiles.length).map(
      (_, index) => new Date(initDate.getTime() + timedeltaMilliseconds(leadAxis, index)),
    ),
    unit: variable.unit,
    variableLabel: variable.label,
    latitude,
    longitude,
    memberCount,
  };
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
  return isForecastSeries(info, variable)
    ? loadPointForecast(info, variable, selections, longitude, latitude, options)
    : loadPointTimeSeries(info, variable, selections, longitude, latitude, options);
}

export { transformGoogleRequest };
