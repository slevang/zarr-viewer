import {
  asyncBufferFromUrl,
  parquetMetadataAsync,
  parquetRead,
  parquetReadObjects,
  parquetSchema,
  type AsyncBuffer,
  type FileMetaData,
} from "hyparquet";
import { compressors } from "hyparquet-compressors";
import type { VariableConfig } from "./data/types";
import { executeDerivedPipeline } from "./derived-variables";
import type {
  AsosRecord,
  AsosStation,
  AsosWindow,
} from "./asos-types";

const ASOS_BASE_URL = [
  "https://s3.us-west-2.amazonaws.com",
  "us-west-2.opendata.source.coop",
  "dynamical/asos-parquet",
].join("/");
const ASOS_WINDOW_MS = 15 * 24 * 60 * 60 * 1000;
const ASOS_FETCH_TIMEOUT_MS = 15_000;
const ASOS_RANGE_CACHE_BYTES = 64 * 1024 * 1024;
const ASOS_STATION_CACHE_ENTRIES = 32;
const ASOS_STATION_CACHE_ROWS = 100_000;
const ASOS_RECORD_COLUMNS = [
  "valid",
  "tmpc",
  "dwpc",
  "relh",
  "drct",
  "sknt",
  "gust",
  "mslp",
  "vsby",
  "p01m",
];

type AsosVariable = {
  label: string;
  unit: string;
  values: (records: AsosRecord[]) => Array<number | null>;
};

type YearFile = {
  url: string;
  byteLength: number;
  etag: string | null;
  metadata: FileMetaData;
};

type RowRange = {
  start: number;
  stop: number;
};

type CachedRange = {
  data: ArrayBuffer;
  size: number;
};

const yearFiles = new Map<
  number,
  { expires: number; promise: Promise<YearFile> }
>();
const stationIndexes = new WeakMap<
  FileMetaData,
  Map<number, Map<string, RowRange[]>>
>();
const rangeCache = new Map<string, CachedRange>();
const stationRecordCache = new Map<string, AsosRecord[]>();
let rangeCacheBytes = 0;
let stationRecordCacheRows = 0;

async function retryingFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const timeoutSignal = AbortSignal.timeout(ASOS_FETCH_TIMEOUT_MS);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    try {
      const response = await fetch(input, { ...init, signal });
      if (
        response.ok
        || (response.status < 500 && response.status !== 429)
      ) return response;
      await response.body?.cancel();
      lastError = new Error(`ASOS request failed (${response.status})`);
    } catch (error) {
      if (init?.signal?.aborted) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw lastError;
}

function parquetUrl(year: number) {
  return `${ASOS_BASE_URL}/year%3D${year}/data.parquet`;
}

async function remoteByteLength(url: string) {
  const response = await retryingFetch(url, {
    headers: { Range: "bytes=0-0" },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`ASOS size request failed (${response.status})`);
  }
  const match = response.headers.get("content-range")?.match(/\/(\d+)$/);
  if (!match) throw new Error("ASOS response did not include Content-Range");
  return {
    byteLength: Number(match[1]),
    etag: response.headers.get("etag"),
  };
}

function rememberRange(key: string, data: ArrayBuffer) {
  if (data.byteLength > ASOS_RANGE_CACHE_BYTES) return;
  const existing = rangeCache.get(key);
  if (existing) rangeCacheBytes -= existing.size;
  rangeCache.delete(key);
  rangeCache.set(key, { data, size: data.byteLength });
  rangeCacheBytes += data.byteLength;
  while (rangeCacheBytes > ASOS_RANGE_CACHE_BYTES) {
    const oldestKey = rangeCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = rangeCache.get(oldestKey);
    rangeCache.delete(oldestKey);
    rangeCacheBytes -= oldest?.size ?? 0;
  }
}

async function yearBuffer(
  {
    url,
    byteLength,
    etag,
  }: Pick<YearFile, "url" | "byteLength" | "etag">,
  signal?: AbortSignal,
): Promise<AsyncBuffer> {
  const remote = await asyncBufferFromUrl({
    url,
    byteLength,
    fetch: (input, init) => retryingFetch(input, {
      ...init,
      signal: init?.signal && signal
        ? AbortSignal.any([init.signal, signal])
        : init?.signal ?? signal,
    }),
    requestInit: etag
      ? { headers: { "If-Match": etag } }
      : undefined,
  });
  const namespace = `${url}:${etag ?? `length-${byteLength}`}`;
  return {
    byteLength,
    async slice(start, end = byteLength) {
      signal?.throwIfAborted();
      const key = `${namespace}:${start}:${end}`;
      const cached = rangeCache.get(key);
      if (cached) {
        rangeCache.delete(key);
        rangeCache.set(key, cached);
        return cached.data;
      }
      const data = await remote.slice(start, end);
      signal?.throwIfAborted();
      rememberRange(key, data);
      return data;
    },
  };
}

async function openYear(year: number): Promise<YearFile> {
  const now = Date.now();
  const cached = yearFiles.get(year);
  if (cached && cached.expires > now) return cached.promise;

  const promise = (async () => {
    const url = parquetUrl(year);
    const remote = await remoteByteLength(url);
    if (remote === null) {
      throw new Error(`No ASOS archive is available for ${year}`);
    }
    const fileInfo = {
      url,
      byteLength: remote.byteLength,
      etag: remote.etag,
    };
    const file = await yearBuffer(fileInfo);
    return {
      ...fileInfo,
      metadata: await parquetMetadataAsync(file),
    };
  })();
  yearFiles.set(year, {
    expires: year === new Date().getUTCFullYear()
      ? now + 5 * 60 * 1000
      : Number.POSITIVE_INFINITY,
    promise,
  });
  try {
    return await promise;
  } catch (error) {
    yearFiles.delete(year);
    throw error;
  }
}

function finiteOrNull(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function asDate(value: unknown) {
  if (value instanceof Date) return value;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeRecord(row: Record<string, unknown>): AsosRecord | null {
  const valid = asDate(row.valid);
  if (!valid) return null;
  return {
    valid,
    tmpc: finiteOrNull(row.tmpc),
    dwpc: finiteOrNull(row.dwpc),
    relh: finiteOrNull(row.relh),
    drct: finiteOrNull(row.drct),
    sknt: finiteOrNull(row.sknt),
    gust: finiteOrNull(row.gust),
    mslp: finiteOrNull(row.mslp),
    vsby: finiteOrNull(row.vsby),
    p01m: finiteOrNull(row.p01m),
  };
}

function stationCacheKey(file: YearFile, station: string) {
  return `${file.url}:${file.etag ?? `length-${file.byteLength}`}:${station}`;
}

function cachedStationRecords(key: string) {
  const cached = stationRecordCache.get(key);
  if (!cached) return null;
  stationRecordCache.delete(key);
  stationRecordCache.set(key, cached);
  return cached;
}

function rememberStationRecords(key: string, records: AsosRecord[]) {
  if (records.length > ASOS_STATION_CACHE_ROWS) return;
  const existing = stationRecordCache.get(key);
  if (existing) stationRecordCacheRows -= existing.length;
  stationRecordCache.delete(key);
  stationRecordCache.set(key, records);
  stationRecordCacheRows += records.length;
  while (
    stationRecordCacheRows > ASOS_STATION_CACHE_ROWS
    || stationRecordCache.size > ASOS_STATION_CACHE_ENTRIES
  ) {
    const oldestKey = stationRecordCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = stationRecordCache.get(oldestKey);
    stationRecordCache.delete(oldestKey);
    stationRecordCacheRows -= oldest?.length ?? 0;
  }
}

const statisticsDecoder = new TextDecoder();

function statisticString(value: unknown) {
  if (value === null || value === undefined) return null;
  return value instanceof Uint8Array
    ? statisticsDecoder.decode(value)
    : String(value);
}

function candidateStationGroups(metadata: FileMetaData, station: string) {
  const stationColumn = parquetSchema(metadata).children.findIndex(
    ({ element }) => element.name === "station",
  );
  if (stationColumn < 0) throw new Error("ASOS archive has no station column");

  let groupStart = 0;
  return metadata.row_groups.flatMap((group, groupIndex) => {
    const start = groupStart;
    const stop = start + Number(group.num_rows);
    groupStart = stop;
    const statistics = group.columns[stationColumn]?.meta_data?.statistics;
    const minimum = statisticString(
      statistics?.min_value ?? statistics?.min,
    );
    const maximum = statisticString(
      statistics?.max_value ?? statistics?.max,
    );
    return (
      (!minimum || !maximum || (station >= minimum && station <= maximum))
        ? [{ groupIndex, start, stop }]
        : []
    );
  });
}

async function stationIndexForGroup(
  file: AsyncBuffer,
  metadata: FileMetaData,
  groupIndex: number,
  start: number,
  stop: number,
  signal?: AbortSignal,
) {
  let indexes = stationIndexes.get(metadata);
  if (!indexes) {
    indexes = new Map();
    stationIndexes.set(metadata, indexes);
  }
  const cached = indexes.get(groupIndex);
  if (cached) return cached;

  // The archive is station-sorted. Streaming this one compact column lets the
  // observation read select a few thousand rows instead of materializing the
  // entire million-row group as objects.
  const index = new Map<string, RowRange[]>();
  await parquetRead({
    file,
    metadata,
    compressors,
    columns: ["station"],
    rowStart: start,
    rowEnd: stop,
    onChunk: ({ columnData, rowStart }) => {
      for (let offset = 0; offset < columnData.length; offset += 1) {
        const value = columnData[offset];
        if (value === null || value === undefined) continue;
        const station = String(value);
        const row = rowStart + offset;
        const ranges = index.get(station) ?? [];
        const previous = ranges.at(-1);
        if (previous?.stop === row) {
          previous.stop = row + 1;
        } else {
          ranges.push({ start: row, stop: row + 1 });
        }
        index.set(station, ranges);
      }
    },
  });
  signal?.throwIfAborted();
  indexes.set(groupIndex, index);
  return index;
}

async function stationRowRanges(
  file: AsyncBuffer,
  metadata: FileMetaData,
  station: string,
  signal?: AbortSignal,
) {
  const groups = candidateStationGroups(metadata, station);
  const ranges = await Promise.all(groups.map(async ({
    groupIndex,
    start,
    stop,
  }) => {
    const index = await stationIndexForGroup(
      file,
      metadata,
      groupIndex,
      start,
      stop,
      signal,
    );
    return index.get(station) ?? [];
  }));
  return ranges.flat();
}

type DirectAsosColumn = keyof Pick<
  AsosRecord,
  "tmpc" | "dwpc" | "relh" | "sknt" | "mslp" | "p01m"
>;

function directObservation(
  column: DirectAsosColumn,
  label: string,
  unit: string,
): AsosVariable {
  return {
    label,
    unit,
    values: (records) => records.map((record) => record[column]),
  };
}

function derivedObservation(variable: VariableConfig): AsosVariable | null {
  if (!variable.derived) return null;
  const inputUnits: Record<string, string> = {
    temperature: "°C",
    dew_point: "°C",
    u: "knot",
    v: "knot",
  };
  const inputs = Object.entries(variable.derived.inputs);
  if (inputs.some(([key]) => !inputUnits[key])) return null;

  const nativeVariables: VariableConfig[] = inputs.map(([key, id]) => ({
    id,
    label: `ASOS ${key}`,
    unit: inputUnits[key],
    dimensions: ["valid"],
  }));
  return {
    label: variable.label,
    unit: variable.unit,
    values: (records) => {
      const requireWindDirection = (
        variable.derived?.key === "wind_direction_10m"
      );
      const values = Object.fromEntries(inputs.map(([key]) => [
        key,
        records.map((record) => {
          if (key === "temperature") return record.tmpc ?? NaN;
          if (key === "dew_point") return record.dwpc ?? NaN;
          if (record.sknt === null) return NaN;
          if (requireWindDirection && record.drct === null) return NaN;
          const direction = (record.drct ?? 0) * Math.PI / 180;
          return key === "u"
            ? -record.sknt * Math.sin(direction)
            : -record.sknt * Math.cos(direction);
        }),
      ]));
      const derived = executeDerivedPipeline(
        variable,
        nativeVariables,
        values,
      );
      return Array.from(
        derived.values,
        (value) => Number.isFinite(value) ? value : null,
      );
    },
  };
}

export function observationVariable(variable: VariableConfig): AsosVariable | null {
  const derived = derivedObservation(variable);
  if (derived) return derived;
  const id = variable.id.toLowerCase();
  const name = `${variable.id} ${variable.label} ${variable.standardName ?? ""}`
    .toLowerCase();
  const dewPoint = (
    id === "d2m"
    || name.includes("dewpoint")
    || name.includes("dew point")
    || name.includes("dew_point")
  );
  if (dewPoint) return directObservation(
    "dwpc",
    "2 m dew point",
    "°C",
  );

  const temperature = (
    id === "t2m"
    || name.includes("temperature_2m")
    || name.includes("2m_temperature")
    || name.includes("2 m temperature")
    || name.includes("2 metre temperature")
  );
  if (temperature) {
    return directObservation("tmpc", "2 m temperature", "°C");
  }
  if (name.includes("relative humidity") || id === "r2") {
    return directObservation("relh", "relative humidity", "%");
  }
  if (
    (name.includes("wind speed") || id === "si10")
    && !name.includes("component")
  ) {
    return directObservation("sknt", "wind speed", "knot");
  }
  if (
    name.includes("mean sea level pressure")
    || name.includes("mean_sea_level_pressure")
    || id === "msl"
  ) {
    return directObservation("mslp", "mean sea-level pressure", "hPa");
  }
  if (
    name.includes("precipitation")
    || name.includes("precip")
    || id === "tp"
  ) {
    return directObservation(
      "p01m",
      "one-hour precipitation",
      "mm/hr",
    );
  }
  return null;
}

async function readYear(
  year: number,
  station: string,
  start: Date,
  stop: Date,
  signal?: AbortSignal,
) {
  const read = async () => {
    const yearFile = await openYear(year);
    signal?.throwIfAborted();
    const cacheKey = stationCacheKey(yearFile, station);
    let records = cachedStationRecords(cacheKey);
    if (!records) {
      const file = await yearBuffer(yearFile, signal);
      const ranges = await stationRowRanges(
        file,
        yearFile.metadata,
        station,
        signal,
      );
      const rows = (await Promise.all(ranges.map((range) =>
        parquetReadObjects({
          file,
          metadata: yearFile.metadata,
          compressors,
          columns: ASOS_RECORD_COLUMNS,
          rowStart: range.start,
          rowEnd: range.stop,
          useOffsetIndex: true,
        })
      ))).flat();
      signal?.throwIfAborted();
      records = rows.flatMap((row) => {
        const record = normalizeRecord(row);
        return record ? [record] : [];
      }).sort((a, b) => a.valid.getTime() - b.valid.getTime());
      rememberStationRecords(cacheKey, records);
    }
    const startTime = start.getTime();
    const stopTime = stop.getTime();
    return records.filter((record) => {
      const valid = record.valid.getTime();
      return valid >= startTime && valid < stopTime;
    });
  };
  try {
    return await read();
  } catch (error) {
    if (
      year === new Date().getUTCFullYear()
      && error instanceof Error
      && error.message.includes("412")
    ) {
      yearFiles.delete(year);
      return read();
    }
    throw error;
  }
}

export async function loadAsosWindow(
  station: AsosStation,
  start: Date,
  variable: VariableConfig,
  options: { signal?: AbortSignal } = {},
): Promise<AsosWindow> {
  const observedVariable = observationVariable(variable);
  if (!observedVariable) {
    return {
      series: null,
      records: [],
      unit: null,
      message: `ASOS has no direct observation equivalent for ${variable.id}`,
    };
  }

  const stop = new Date(start.getTime() + ASOS_WINDOW_MS);
  const years: number[] = [];
  for (
    let year = start.getUTCFullYear();
    year <= stop.getUTCFullYear();
    year += 1
  ) years.push(year);
  const records = (await Promise.all(
    years.map(async (year) => {
      try {
        return await readYear(
          year,
          station.station,
          start,
          stop,
          options.signal,
        );
      } catch (error) {
        if (
          error instanceof Error
          && error.message.startsWith("No ASOS archive is available")
        ) return [];
        throw error;
      }
    }),
  )).flat().sort((a, b) => a.valid.getTime() - b.valid.getTime());

  const observedValues = observedVariable.values(records);
  const values = records.flatMap((record, index) => {
    const value = observedValues[index];
    return value === null || value === undefined ? [] : [{
      date: record.valid,
      value,
    }];
  });
  return {
    series: values.length ? {
      kind: "history",
      dates: values.map(({ date }) => date),
      values: values.map(({ value }) => value),
      unit: observedVariable.unit,
      variableLabel: `ASOS ${observedVariable.label}`,
      latitude: station.latitude,
      longitude: station.longitude,
    } : null,
    records,
    unit: observedVariable.unit,
    message: values.length
      ? `${values.length} hourly observations`
      : "No observations in this 15-day window",
  };
}
