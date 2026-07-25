import {
  asyncBufferFromUrl,
  parquetMetadataAsync,
  parquetReadObjects,
  type FileMetaData,
} from "hyparquet";
import { compressors } from "hyparquet-compressors";
import type { VariableConfig } from "./dataset";
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
const ASOS_COLUMNS = [
  "station",
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
  column: keyof Pick<
    AsosRecord,
    "tmpc" | "dwpc" | "relh" | "sknt" | "mslp" | "p01m"
  >;
  label: string;
  unit: string;
};

type YearFile = {
  url: string;
  byteLength: number;
  etag: string | null;
  metadata: FileMetaData;
};

const yearFiles = new Map<
  number,
  { expires: number; promise: Promise<YearFile> }
>();

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
    const file = await asyncBufferFromUrl({
      url,
      byteLength: remote.byteLength,
      fetch: retryingFetch,
      requestInit: remote.etag
        ? { headers: { "If-Match": remote.etag } }
        : undefined,
    });
    return {
      url,
      byteLength: remote.byteLength,
      etag: remote.etag,
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

function observationVariable(variable: VariableConfig): AsosVariable | null {
  const id = variable.id.toLowerCase();
  const name = `${variable.id} ${variable.label} ${variable.standardName ?? ""}`
    .toLowerCase();
  const dewPoint = (
    id === "d2m"
    || name.includes("dewpoint")
    || name.includes("dew point")
    || name.includes("dew_point")
  );
  if (dewPoint) return { column: "dwpc", label: "2 m dew point", unit: "°C" };

  const temperature = (
    id === "t2m"
    || name.includes("temperature_2m")
    || name.includes("2m_temperature")
    || name.includes("2 m temperature")
    || name.includes("2 metre temperature")
  );
  if (temperature) {
    return { column: "tmpc", label: "2 m temperature", unit: "°C" };
  }
  if (name.includes("relative humidity") || id === "r2") {
    return { column: "relh", label: "relative humidity", unit: "%" };
  }
  if (
    (name.includes("wind speed") || id === "si10")
    && !name.includes("component")
  ) {
    return { column: "sknt", label: "wind speed", unit: "knot" };
  }
  if (
    name.includes("mean sea level pressure")
    || name.includes("mean_sea_level_pressure")
    || id === "msl"
  ) {
    return { column: "mslp", label: "mean sea-level pressure", unit: "hPa" };
  }
  if (
    name.includes("precipitation")
    || name.includes("precip")
    || id === "tp"
  ) {
    return { column: "p01m", label: "one-hour precipitation", unit: "mm" };
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
    const {
      url,
      byteLength,
      etag,
      metadata,
    } = await openYear(year);
    signal?.throwIfAborted();
    const file = await asyncBufferFromUrl({
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
    return parquetReadObjects({
      file,
      metadata,
      compressors,
      columns: ASOS_COLUMNS,
      filter: {
        $and: [
          { station: { $eq: station } },
          { valid: { $gte: start, $lt: stop } },
        ],
      },
      useOffsetIndex: true,
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
  const rows = (await Promise.all(
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
  )).flat();

  const records = rows.flatMap((row) => {
    const valid = asDate(row.valid);
    if (!valid) return [];
    return [{
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
    } satisfies AsosRecord];
  }).sort((a, b) => a.valid.getTime() - b.valid.getTime());

  const values = records.flatMap((record) => {
    const value = record[observedVariable.column];
    return value === null ? [] : [{
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
