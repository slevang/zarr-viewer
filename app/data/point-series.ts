import proj4 from "proj4";
import * as zarr from "zarrita";
import type { DatasetSourceConfig } from "../catalog";
import { createBoundedAsyncQueue } from "../async-queue";
import {
  axisValueAsDate,
  isForecastSeries,
  timedeltaMilliseconds,
} from "./axes";
import {
  isEnsembleDimension,
  isInitializationDimension,
  isSpatialDimension,
  spatialDimension,
} from "./dimensions";
import type {
  AxisSelection,
  PointForecastSeries,
  PointSeriesLoadOptions,
  PointTimeSeries,
  StoreInfo,
  VariableConfig,
} from "./types";
import {
  executeDerivedPipeline,
  nativeInputsForDerived,
} from "../derived-variables";

const HOUR_MS = 60 * 60 * 1000;
const SERIES_CHUNK_CONCURRENCY = 6;
export const SERIES_LOOKAHEAD_MS = 15 * 24 * HOUR_MS;
export const SERIES_LOOKAHEAD_HOURS = SERIES_LOOKAHEAD_MS / HOUR_MS;
const coordinateValuesPromises = new WeakMap<
  StoreInfo,
  Map<string, Promise<number[]>>
>();

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
  const latitudeDimension = spatialDimension(variable, info.source, "lat");
  const longitudeDimension = spatialDimension(variable, info.source, "lon");
  if (!latitudeDimension || !longitudeDimension) return null;

  options.signal?.throwIfAborted();
  const [latitudeValues, longitudeValues] = await Promise.all([
    coordinateValues(info, latitudeDimension, options.concurrency),
    coordinateValues(info, longitudeDimension, options.concurrency),
  ]);
  options.signal?.throwIfAborted();
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

function zarrReadOptions(options: PointSeriesLoadOptions) {
  return {
    signal: options.signal,
    createQueue: () => createBoundedAsyncQueue(
      options.concurrency ?? SERIES_CHUNK_CONCURRENCY,
    ),
  };
}

function coordinateValues(
  info: StoreInfo,
  dimension: string,
  concurrency?: number,
) {
  let cache = coordinateValuesPromises.get(info);
  if (!cache) {
    cache = new Map();
    coordinateValuesPromises.set(info, cache);
  }
  const cached = cache.get(dimension);
  if (cached) return cached;
  const promise = (async () => {
    if (!info.store) return [];
    const array = await zarr.open(
      zarr.root(info.store).resolve(dimension),
      { kind: "array" },
    );
    const result = await zarr.get(
      array,
      null,
      zarrReadOptions({ concurrency }),
    );
    return Array.from(
      result.data as ArrayLike<number | bigint>,
      Number,
    );
  })().catch((error) => {
    cache?.delete(dimension);
    throw error;
  });
  cache.set(dimension, promise);
  return promise;
}

export async function preloadPointSeriesCoordinates(
  info: StoreInfo,
  concurrency = 2,
) {
  if (info.role !== "series" || !info.store) return;
  const dimensions = new Set(
    info.variables.flatMap((variable) =>
      variable.dimensions.filter(
        (dimension) => isSpatialDimension(dimension, info.source),
      )
    ),
  );
  await Promise.all(
    Array.from(
      dimensions,
      (dimension) => coordinateValues(info, dimension, concurrency),
    ),
  );
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
      && isInitializationDimension(dimension),
  );
  const leadDimension = variable.dimensions.find(
    (dimension) => info.axes[dimension]?.kind === "timedelta",
  );
  const memberDimension = variable.dimensions.find(isEnsembleDimension);
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
