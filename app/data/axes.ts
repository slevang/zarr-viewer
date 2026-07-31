import type { Selector } from "@carbonplan/zarr-layer";
import {
  getDatasetSource,
  type DatasetConfig,
  type DatasetSourceConfig,
} from "../catalog";
import {
  isLatitudeDimension,
  isLongitudeDimension,
  isInitializationDimension,
  isValidTimeDimension,
} from "./dimensions";
import type {
  AxisConfig,
  AxisSelection,
  StoreInfo,
  VariableConfig,
} from "./types";

const HOUR_MS = 60 * 60 * 1000;
const SERIES_LOOKAHEAD_HOURS = 15 * 24;
const DEFAULT_FORECAST_LEAD_INDEX = 1;

export function regularSpatialCoordinateValues(
  source: DatasetSourceConfig,
  dimension: string,
  length: number,
) {
  if (
    source.spatialCoordinates !== "regular-global"
    || !source.bounds
    || length <= 0
  ) return undefined;
  const [west, south, east, north] = source.bounds;
  if (isLatitudeDimension(dimension, source)) {
    if (length === 1) return [source.latIsAscending === false ? north : south];
    const step = (north - south) / (length - 1);
    return Array.from(
      { length },
      (_, index) => source.latIsAscending === false
        ? north - index * step
        : south + index * step,
    );
  }
  if (isLongitudeDimension(dimension, source)) {
    const step = (east - west) / length;
    return Array.from({ length }, (_, index) => west + index * step);
  }
  return undefined;
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

export function isForecastSeries(
  info: StoreInfo,
  variable: VariableConfig,
) {
  return variable.dimensions.some(
    (dimension) => info.axes[dimension]?.kind === "timedelta",
  );
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
        isValidTimeDimension(dimension)
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
      : axis.kind === "timedelta" && info.dataset.category === "forecast"
        ? Math.min(DEFAULT_FORECAST_LEAD_INDEX, axis.values.length - 1)
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
  const valid = time.find(isValidTimeDimension);
  const initialization = valid
    ?? time.find(isInitializationDimension)
    ?? time[0];
  const lead = dimensions.find(
    (dimension) => info.axes[dimension]?.kind === "timedelta",
  );
  return { valid, initialization, lead };
}

export function preserveForecastLeadSelection(
  previousInfo: StoreInfo,
  previousVariable: VariableConfig,
  previousSelections: AxisSelection,
  nextInfo: StoreInfo,
  nextVariable: VariableConfig,
  nextSelections: AxisSelection,
) {
  const previousLead = temporalDimensions(previousInfo, previousVariable).lead;
  const nextLead = temporalDimensions(nextInfo, nextVariable).lead;
  if (!previousLead || !nextLead) return nextSelections;
  const previousIndex = previousSelections[previousLead];
  const nextAxis = nextInfo.axes[nextLead];
  if (previousIndex === undefined || !nextAxis?.values.length) {
    return nextSelections;
  }
  return {
    ...nextSelections,
    [nextLead]: Math.max(
      0,
      Math.min(nextAxis.values.length - 1, previousIndex),
    ),
  };
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

export function axisValueAsDate(
  _dataset: DatasetConfig,
  axis: AxisConfig,
  index: number,
) {
  const value = Number(axis.values[index]);
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
