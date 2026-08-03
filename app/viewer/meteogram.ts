import type { DatasetConfig, DatasetSourceConfig } from "../catalog";
import { defaultSelections, timedeltaMilliseconds } from "../data/axes";
import type {
  AxisSelection,
  PointSeries,
  StoreInfo,
  VariableConfig,
} from "../data/types";
import { convertUnitValue } from "../units";
import { comparisonTimeIndex, isInitializationAxis } from "./variables";

export type MeteogramViewMode = "series" | "meteogram";
export type MeteogramLocation = {
  latitude: number;
  longitude: number;
  station?: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function containsPoint(
  source: DatasetSourceConfig | undefined,
  longitude: number,
  latitude: number,
) {
  const bounds = source?.geographicBounds;
  if (!bounds) return true;
  const [west, south, east, north] = bounds;
  const longitudeMatches = west <= east
    ? longitude >= west && longitude <= east
    : longitude >= west || longitude <= east;
  return longitudeMatches && latitude >= south && latitude <= north;
}

export function meteogramComparisonDatasets(
  datasets: DatasetConfig[],
  longitude: number,
  latitude: number,
  preferredDatasetId?: string,
) {
  return datasets
    .filter((dataset) => {
      const source = dataset.sources.series;
      return Boolean(
        source?.meteogram
        && (
          source.meteogram.comparisonPriority !== undefined
          || dataset.id === preferredDatasetId
        )
        && containsPoint(source, longitude, latitude),
      );
    })
    .sort((first, second) => {
      const firstPreferred = first.id === preferredDatasetId;
      const secondPreferred = second.id === preferredDatasetId;
      if (firstPreferred !== secondPreferred) return firstPreferred ? -1 : 1;
      return (first.sources.series?.meteogram?.comparisonPriority ?? Infinity)
        - (second.sources.series?.meteogram?.comparisonPriority ?? Infinity);
    });
}

export function preferredRegionalMeteogramDataset(
  datasets: DatasetConfig[],
  longitude: number,
  latitude: number,
) {
  return meteogramComparisonDatasets(datasets, longitude, latitude).find(
    (dataset) => dataset.sources.series?.meteogram?.kind === "regional",
  );
}

export function primaryMeteogramDataset(datasets: DatasetConfig[]) {
  return datasets.find(
    (dataset) => dataset.sources.series?.meteogram?.kind === "global-ensemble",
  ) ?? datasets[0];
}

export function trimMeteogramSeries(
  series: PointSeries,
  firstLeadHour = 0,
): PointSeries {
  if (firstLeadHour <= 0 || series.dates.length < 2) return series;
  const threshold = series.dates[0].getTime() + firstLeadHour * 60 * 60 * 1000;
  const start = series.dates.findIndex((date) => date.getTime() >= threshold);
  if (start <= 0) return series;
  if (series.kind === "history") {
    return {
      ...series,
      dates: series.dates.slice(start),
      values: series.values.slice(start),
    };
  }
  return {
    ...series,
    dates: series.dates.slice(start),
    quantiles: series.quantiles.slice(start),
  };
}

export function meteogramStartSelections(
  info: StoreInfo,
  variable: VariableConfig,
  selections: AxisSelection,
): AxisSelection {
  const firstLeadHour = info.source.meteogram?.firstLeadHour;
  if (!firstLeadHour) return selections;
  const leadDimension = variable.dimensions.find(
    (dimension) => info.axes[dimension]?.kind === "timedelta",
  );
  const leadAxis = leadDimension ? info.axes[leadDimension] : undefined;
  if (!leadDimension || !leadAxis) return selections;
  const requestedMilliseconds = firstLeadHour * 60 * 60 * 1000;
  const index = leadAxis.values.findIndex(
    (_value, candidate) =>
      timedeltaMilliseconds(leadAxis, candidate) >= requestedMilliseconds,
  );
  return index < 0
    ? selections
    : { ...selections, [leadDimension]: index };
}

export function meteogramSelectionsForInitialization(
  info: StoreInfo,
  variable: VariableConfig,
  initializationDate?: Date,
): AxisSelection {
  const selections = defaultSelections(info, variable);
  if (!initializationDate) return selections;
  const dimensions = new Set([
    ...variable.dimensions,
    ...Object.values(info.axes)
      .filter((axis) => axis.requiresStoreReload)
      .map((axis) => axis.id),
  ]);
  for (const dimension of dimensions) {
    const axis = info.axes[dimension];
    if (axis?.kind === "time" && isInitializationAxis(axis)) {
      selections[dimension] = comparisonTimeIndex(
        info,
        variable,
        axis,
        initializationDate,
      );
    }
  }
  return selections;
}

function centralValues(series: PointSeries) {
  return series.kind === "history"
    ? series.values
    : series.quantiles.map((item) => item.q50);
}

export function normalizeMeteogramPercentSeries(
  series: PointSeries | undefined,
) {
  if (!series) return undefined;
  const values = centralValues(series).filter(Number.isFinite);
  const scale = Math.max(...values, 0) <= 1.5 ? 100 : 1;
  if (scale === 1 && series.unit === "%") return series;
  if (series.kind === "history") {
    return {
      ...series,
      values: series.values.map((value) => value * scale),
      unit: "%",
    };
  }
  return {
    ...series,
    quantiles: series.quantiles.map((item) => ({
      min: item.min * scale,
      q10: item.q10 * scale,
      q25: item.q25 * scale,
      q50: item.q50 * scale,
      q75: item.q75 * scale,
      q90: item.q90 * scale,
      max: item.max * scale,
    })),
    unit: "%",
  };
}

export function stitchMeteogramSeries(
  preferred: PointSeries | undefined,
  fallback: PointSeries | undefined,
): PointSeries | undefined {
  if (!preferred) return fallback;
  if (!fallback) return preferred;
  const preferredValues = centralValues(preferred);
  const finitePreferred = preferred.dates.flatMap((date, index) =>
    Number.isFinite(preferredValues[index])
      ? [[date.getTime(), preferredValues[index]] as const]
      : []
  );
  if (!finitePreferred.length) return fallback;
  const preferredStart = finitePreferred[0][0];
  const preferredStop = finitePreferred.at(-1)?.[0] ?? preferredStart;
  const fallbackValues = centralValues(fallback);
  const combined = [
    ...fallback.dates.flatMap((date, index) => {
      const timestamp = date.getTime();
      const value = convertUnitValue(
        fallbackValues[index],
        fallback.unit,
        preferred.unit,
      );
      return Number.isFinite(value)
        && (timestamp < preferredStart || timestamp > preferredStop)
        ? [[timestamp, value] as const]
        : [];
    }),
    ...finitePreferred,
  ].sort((first, second) => first[0] - second[0]);
  const unique = combined.filter(
    (item, index) => index === 0 || item[0] !== combined[index - 1][0],
  );
  return {
    kind: "history",
    dates: unique.map(([timestamp]) => new Date(timestamp)),
    values: unique.map(([, value]) => value),
    unit: preferred.unit,
    variableLabel: preferred.variableLabel,
    latitude: preferred.latitude,
    longitude: preferred.longitude,
  };
}

export function meteogramHoverTimestamps(series: PointSeries[]) {
  return Array.from(new Set(
    series.flatMap((candidate) =>
      candidate.dates.map((date) => date.getTime()).filter(Number.isFinite)
    ),
  )).sort((left, right) => left - right);
}

export function nearestTimestamp(timestamps: number[], target: number) {
  if (!timestamps.length) return target;
  let low = 0;
  let high = timestamps.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (timestamps[middle] < target) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return timestamps[0];
  const previous = timestamps[low - 1];
  const next = timestamps[low];
  return target - previous <= next - target ? previous : next;
}

export function meteogramDayTicks(start: number, stop: number) {
  if (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) {
    return [];
  }
  const firstMidnight = Math.ceil(start / DAY_MS) * DAY_MS;
  const dayCount = Math.max(1, Math.ceil((stop - start) / DAY_MS));
  const labelEvery = dayCount <= 8 ? 1 : dayCount <= 18 ? 2 : 3;
  return Array.from(
    { length: Math.max(0, Math.floor((stop - firstMidnight) / DAY_MS) + 1) },
    (_, index) => ({
      timestamp: firstMidnight + index * DAY_MS,
      showLabel: index % labelEvery === 0,
    }),
  );
}

export function windArrowRotation(direction: number) {
  return (direction + 180) % 360;
}
