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
  ForecastQuantiles,
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
import { commonVariableMatches } from "../common-variables";
import { PRECIPITATION_EVENT_THRESHOLD_MM } from "../precipitation";
import {
  precipitationRateConverter,
  unitConverter,
} from "../units";

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
  const dates = Array.from(
    { length: values.length },
    (_, offset) => axisValueAsDate(info.dataset, timeAxis, start + offset),
  );
  const precipitation = pointPrecipitationRates(
    values,
    dates,
    1,
    variable,
    info.source.precipitationAccumulation,
  );
  return {
    kind: "history",
    values: precipitation ? Array.from(precipitation.values) : values,
    dates,
    unit: precipitation?.unit ?? variable.unit,
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

export function circularMeanDegrees(values: ArrayLike<number>) {
  let sine = 0;
  let cosine = 0;
  let count = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index]);
    if (!Number.isFinite(value)) continue;
    const radians = value * Math.PI / 180;
    sine += Math.sin(radians);
    cosine += Math.cos(radians);
    count += 1;
  }
  if (!count || Math.hypot(sine, cosine) <= count * 1e-12) return NaN;
  return (Math.atan2(sine, cosine) * 180 / Math.PI + 360) % 360;
}

export function forecastQuantiles(
  variable: VariableConfig,
  values: ArrayLike<number>,
): ForecastQuantiles {
  const members = Array.from(values, Number).filter(Number.isFinite);
  if (variable.standardName?.toLowerCase() === "wind_from_direction") {
    // Scalar intervals cannot represent a distribution that crosses north.
    // Expose its circular center without inventing misleading linear bands.
    const center = circularMeanDegrees(members);
    return {
      min: center,
      q10: center,
      q25: center,
      q50: center,
      q75: center,
      q90: center,
      max: center,
    };
  }
  members.sort((a, b) => a - b);
  return {
    min: members[0] ?? NaN,
    q10: quantile(members, 0.1),
    q25: quantile(members, 0.25),
    q50: quantile(members, 0.5),
    q75: quantile(members, 0.75),
    q90: quantile(members, 0.9),
    max: members.at(-1) ?? NaN,
  };
}

type RawPointForecast = {
  values: Float64Array;
  dates: Date[];
  leadCount: number;
  memberCount: number;
  latitude: number;
  longitude: number;
};

function precipitationContext(variable: VariableConfig) {
  return [
    variable.id,
    variable.label,
    variable.standardName ?? "",
  ].join(" ");
}

function isPrecipitationVariable(variable: VariableConfig) {
  return commonVariableMatches([variable]).some((match) => match.key === "tp");
}

export function pointPrecipitationRates(
  values: ArrayLike<number>,
  dates: Date[],
  memberCount: number,
  variable: VariableConfig,
  accumulation?: DatasetSourceConfig["precipitationAccumulation"],
): {
  values: Float64Array;
  amounts: Float64Array;
  unit: "mm/h";
} | null {
  if (!isPrecipitationVariable(variable)) return null;
  const context = precipitationContext(variable);
  const rateConverter = precipitationRateConverter(variable.unit, context);
  const cumulative = accumulation === "cumulative";
  const toMillimeters = rateConverter
    ? null
    : unitConverter(variable.unit, "mm", context);
  if (!rateConverter && !toMillimeters) return null;

  const rateValues = new Float64Array(values.length);
  const amountValues = new Float64Array(values.length);
  rateValues.fill(NaN);
  amountValues.fill(NaN);
  const leadCount = Math.min(
    dates.length,
    Math.floor(values.length / Math.max(1, memberCount)),
  );
  for (let leadIndex = 0; leadIndex < leadCount; leadIndex += 1) {
    const previousDate = dates[leadIndex - 1];
    const nextDate = dates[leadIndex + 1];
    const durationSeconds = Math.max(
      0,
      (
        previousDate
          ? dates[leadIndex].getTime() - previousDate.getTime()
          : (nextDate?.getTime() ?? dates[leadIndex].getTime())
            - dates[leadIndex].getTime()
      ) / 1000,
    );
    const durationHours = durationSeconds / 3600;
    for (let memberIndex = 0; memberIndex < memberCount; memberIndex += 1) {
      const offset = leadIndex * memberCount + memberIndex;
      const current = Number(values[offset]);
      if (rateConverter) {
        const rate = Number.isFinite(current)
          ? Math.max(0, rateConverter(current, 3600))
          : NaN;
        rateValues[offset] = rate;
        amountValues[offset] = Number.isFinite(rate) && durationHours > 0
          ? rate * durationHours
          : NaN;
        continue;
      }
      const currentMillimeters = toMillimeters!(current);
      const amount = cumulative
        ? (() => {
          const previousMillimeters = leadIndex > 0
            ? toMillimeters!(Number(values[offset - memberCount]))
            : currentMillimeters === 0
              ? 0
              : NaN;
          return Number.isFinite(currentMillimeters)
              && Number.isFinite(previousMillimeters)
            ? Math.max(0, currentMillimeters - previousMillimeters)
            : NaN;
        })()
        : Number.isFinite(currentMillimeters)
          ? Math.max(0, currentMillimeters)
          : NaN;
      amountValues[offset] = amount;
      rateValues[offset] = Number.isFinite(amount) && durationHours > 0
        ? amount / durationHours
        : NaN;
    }
  }
  return {
    values: rateValues,
    amounts: amountValues,
    unit: "mm/h",
  };
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
    (_, leadIndex) => forecastQuantiles(
      variable,
      Array.from(
        { length: raw.memberCount },
        (_, memberIndex) => Number(
          values[leadIndex * raw.memberCount + memberIndex],
        ),
      ),
    ),
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
  if (!raw) return null;
  const precipitation = pointPrecipitationRates(
    raw.values,
    raw.dates,
    raw.memberCount,
    variable,
    info.source.precipitationAccumulation,
  );
  return pointForecastFromRaw(
    raw,
    variable,
    precipitation?.values ?? raw.values,
    precipitation?.unit ?? variable.unit,
  );
}

export type PointPrecipitationForecast = {
  rate: PointForecastSeries;
  probability: PointTimeSeries;
};

export async function loadPointPrecipitationForecast(
  info: StoreInfo,
  variable: VariableConfig,
  selections: AxisSelection,
  longitude: number,
  latitude: number,
  options: PointSeriesLoadOptions = {},
  thresholdMillimeters = PRECIPITATION_EVENT_THRESHOLD_MM,
): Promise<PointPrecipitationForecast | null> {
  const raw = await loadRawPointForecast(
    info,
    variable,
    selections,
    longitude,
    latitude,
    options,
  );
  if (!raw) return null;
  const normalized = pointPrecipitationRates(
    raw.values,
    raw.dates,
    raw.memberCount,
    variable,
    info.source.precipitationAccumulation,
  );
  if (!normalized) return null;

  const probabilities = new Array<number>(raw.leadCount).fill(NaN);
  for (let leadIndex = 0; leadIndex < raw.leadCount; leadIndex += 1) {
    let wetMembers = 0;
    let finiteMembers = 0;
    for (let memberIndex = 0; memberIndex < raw.memberCount; memberIndex += 1) {
      const offset = leadIndex * raw.memberCount + memberIndex;
      const step = normalized.amounts[offset];
      if (Number.isFinite(step)) {
        finiteMembers += 1;
        if (step >= thresholdMillimeters) wetMembers += 1;
      }
    }
    probabilities[leadIndex] = finiteMembers
      ? 100 * wetMembers / finiteMembers
      : NaN;
  }
  return {
    rate: pointForecastFromRaw(
      raw,
      variable,
      normalized.values,
      normalized.unit,
    ),
    probability: {
      kind: "history",
      values: probabilities,
      dates: [...raw.dates],
      unit: "%",
      variableLabel: `Precipitation likelihood (≥${thresholdMillimeters} mm/step)`,
      latitude: raw.latitude,
      longitude: raw.longitude,
    },
  };
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
