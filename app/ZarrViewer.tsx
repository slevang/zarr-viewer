import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  COLORMAPS,
  DEFAULT_COLORMAP,
  defaultColormap,
} from "./colormaps";
import {
  DATASETS,
  DEFAULT_DATASET_ID,
  getDataset,
  hasMapSource,
  hasSeriesSource,
  type DatasetSourceConfig,
} from "./catalog";
import {
  SeriesComparison,
  type ComparisonSeriesEntry,
} from "./SeriesComparison";
import {
  axisDateInputValue,
  axisIndexForDate,
  axisValueAsDate,
  defaultSelections,
  formatAxisValue,
  isForecastSeries,
  loadPointSeries,
  loadStoreInfo,
  reconcileSelections,
  selectorFor,
  timedeltaMilliseconds,
  toDataCoordinates,
  type AxisConfig,
  type AxisSelection,
  type StoreInfo,
  type VariableConfig,
} from "./dataset";

type Projection = "globe" | "mercator";
type InspectionPoint = { lng: number; lat: number };
type Inspector = InspectionPoint & { value: number | null };
type Limit = "min" | "max";
type LoadState = { phase: "loading" | "ready" | "error"; message: string };
type PlaybackPrefetchQueue = {
  generation: number;
  axisId: string;
  ahead: number;
  concurrency: number;
  directChunkReads: boolean;
  rampUp: boolean;
  controller: AbortController;
  ready: Set<number>;
  promises: Map<number, Promise<void>>;
  resolve: Map<number, () => void>;
  queued: number[];
  queuedSet: Set<number>;
  inFlight: Set<number>;
  attempts: Map<number, number>;
};

const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const ZARR_LAYER_ID = "zarr-data";
const PLAYBACK_DATA_HOURS_PER_SECOND = 6;
const PLAYBACK_FALLBACK_INTERVAL_MS = 250;
const PLAYBACK_PREFETCH_BASE_AHEAD = 10;
const PLAYBACK_PREFETCH_MAX_AHEAD = 120;
const PLAYBACK_PREFETCH_FALLBACK_CONCURRENCY = 2;
const PLAYBACK_PREFETCH_MAX_CONCURRENCY = 32;
const PLAYBACK_PREFETCH_MEMORY_BUDGET_BYTES = 1024 * 1024 * 1024;
const COLOR_RANGE_ESTIMATOR_VERSION = 3;
const DEFAULT_CENTER: [number, number] = [-98, 38.5];
const DEFAULT_ZOOM = 1.75;
const READY_STATE: LoadState = { phase: "ready", message: "Ready" };
const MAP_DATASETS = DATASETS.filter(hasMapSource);
const TIME_SERIES_DATASETS = DATASETS.filter(hasSeriesSource);
const FULL_IMAGE_GEOMETRIES = [
  [-179.999, 0],
  [0, 179.999],
].map(([west, east]) => ({
  type: "Polygon" as const,
  coordinates: [[
    [west, -89.999],
    [east, -89.999],
    [east, 89.999],
    [west, 89.999],
    [west, -89.999],
  ]],
}));

function loadingState(message = "Loading…"): LoadState {
  return { phase: "loading", message };
}

function errorState(error: unknown): LoadState {
  return { phase: "error", message: error instanceof Error ? error.message : String(error) };
}

function playbackInterval(
  dataset: ReturnType<typeof getDataset>,
  axis: AxisConfig,
  currentIndex: number,
  nextIndex: number,
) {
  let stepMilliseconds = NaN;
  if (axis.kind === "time") {
    stepMilliseconds = Math.abs(
      axisValueAsDate(dataset, axis, nextIndex).getTime()
      - axisValueAsDate(dataset, axis, currentIndex).getTime(),
    );
  } else if (axis.kind === "timedelta") {
    stepMilliseconds = Math.abs(
      timedeltaMilliseconds(axis, nextIndex)
      - timedeltaMilliseconds(axis, currentIndex),
    );
  }
  if (!Number.isFinite(stepMilliseconds) || stepMilliseconds <= 0) {
    return PLAYBACK_FALLBACK_INTERVAL_MS;
  }
  const dataHours = stepMilliseconds / 3_600_000;
  return Math.max(
    100,
    Math.min(4_000, (dataHours / PLAYBACK_DATA_HOURS_PER_SECOND) * 1_000),
  );
}

function dataTypeByteWidth(dataType?: string) {
  const normalized = dataType?.toLowerCase() ?? "";
  if (normalized.includes("64") || /[fiu]8$/.test(normalized)) return 8;
  if (normalized.includes("16") || /[fiu]2$/.test(normalized)) return 2;
  if (normalized.includes("8") || /[iu]1$/.test(normalized)) return 1;
  return 4;
}

function formatDecodedBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function formatChunkShape(variable: VariableConfig, shape: number[]) {
  const dimensions = shape.map(
    (length, index) => `${variable.dimensions[index] ?? `dim ${index + 1}`} ${length}`,
  ).join(" × ");
  const bytes = shape.reduce(
    (total, length) => total * Math.max(1, length),
    dataTypeByteWidth(variable.dataType),
  );
  return `${dimensions} · ${formatDecodedBytes(bytes)} decoded`;
}

function chunkingSummary(variable: VariableConfig | null) {
  if (!variable?.chunkShape) return "Loading chunk metadata…";
  const outer = formatChunkShape(variable, variable.chunkShape);
  return variable.innerChunkShape
    ? `Chunk: ${formatChunkShape(variable, variable.innerChunkShape)} · shard: ${outer}`
    : `Chunk: ${outer}`;
}

function playbackPrefetchProfile(
  source: DatasetSourceConfig,
  variable: VariableConfig,
  axis: AxisConfig,
) {
  const axisIndex = variable.dimensions.indexOf(axis.id);
  const { shape, chunkShape } = variable;
  if (
    axisIndex < 0
    || !chunkShape
    || chunkShape.length !== variable.dimensions.length
  ) {
    return {
      ahead: PLAYBACK_PREFETCH_BASE_AHEAD,
      concurrency: PLAYBACK_PREFETCH_FALLBACK_CONCURRENCY,
      directChunkReads: false,
    };
  }

  const axisChunkLength = Math.max(1, Math.floor(chunkShape[axisIndex] ?? 1));
  const decodedChunkBytes = chunkShape.reduce(
    (total, length) => total * Math.max(1, length),
    dataTypeByteWidth(variable.dataType),
  );
  const memoryFrameCap = Math.max(
    1,
    Math.floor(PLAYBACK_PREFETCH_MEMORY_BUDGET_BYTES / decodedChunkBytes),
  );

  let spatialChunksPerFrame = 1;
  if (shape?.length === chunkShape.length) {
    variable.dimensions.forEach((dimension, index) => {
      const lower = dimension.toLowerCase();
      const spatial = (
        lower === "latitude"
        || lower === "longitude"
        || lower === "lat"
        || lower === "lon"
        || lower === "x"
        || lower === "y"
        || source.spatialDimensions?.lat === dimension
        || source.spatialDimensions?.lon === dimension
      );
      if (spatial) {
        spatialChunksPerFrame *= Math.ceil(
          Math.max(1, shape[index] ?? 1) / Math.max(1, chunkShape[index] ?? 1),
        );
      }
    });
  }
  const spatialCap = spatialChunksPerFrame <= 1
    ? PLAYBACK_PREFETCH_MAX_CONCURRENCY
    : spatialChunksPerFrame <= 4
      ? 6
      : spatialChunksPerFrame <= 16
        ? 3
        : 2;
  const directChunkReads = (
    source.id === "earthmover-era5-single-spatial"
    && spatialChunksPerFrame === 1
  );
  const ahead = directChunkReads
    ? PLAYBACK_PREFETCH_BASE_AHEAD
    : spatialChunksPerFrame === 1
    ? Math.min(PLAYBACK_PREFETCH_MAX_AHEAD, memoryFrameCap)
    : Math.min(PLAYBACK_PREFETCH_BASE_AHEAD, memoryFrameCap);
  const temporalChunkCount = Math.max(
    1,
    Math.ceil(ahead / axisChunkLength),
  );
  const temporalCap = axisChunkLength >= 10
    ? 1
    : temporalChunkCount;

  return {
    ahead,
    concurrency: Math.max(
      1,
      Math.min(
        PLAYBACK_PREFETCH_MAX_CONCURRENCY,
        temporalCap,
        spatialCap,
      ),
    ),
    directChunkReads,
  };
}

function playbackChunkKey(
  variable: VariableConfig,
  selections: AxisSelection,
): `/${string}` | undefined {
  const { shape, chunkShape } = variable;
  if (
    !shape
    || !chunkShape
    || shape.length !== variable.dimensions.length
    || chunkShape.length !== variable.dimensions.length
  ) return undefined;
  const chunkCoordinates = variable.dimensions.map((dimension, index) => {
    const lower = dimension.toLowerCase();
    const spatial = (
      lower === "latitude"
      || lower === "longitude"
      || lower === "lat"
      || lower === "lon"
      || lower === "x"
      || lower === "y"
    );
    if (spatial) {
      if ((shape[index] ?? 1) > (chunkShape[index] ?? 1)) return NaN;
      return 0;
    }
    return Math.floor(
      (selections[dimension] ?? 0) / Math.max(1, chunkShape[index] ?? 1),
    );
  });
  if (chunkCoordinates.some((value) => !Number.isFinite(value))) return undefined;
  return `/${variable.id}/c/${chunkCoordinates.join("/")}`;
}

function shortCoordinate(value: number, positive: string, negative: string) {
  return `${Math.abs(value).toFixed(2)}°${value >= 0 ? positive : negative}`;
}

function firstFinite(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    for (const item of Array.from(value as ArrayLike<unknown>)) {
      const match = firstFinite(item);
      if (match !== undefined) return match;
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const match = firstFinite(item);
      if (match !== undefined) return match;
    }
  }
  return undefined;
}

function decimalsForRange([min, max]: readonly [number, number]) {
  const width = Math.abs(max - min);
  if (width >= 1000) return 0;
  if (width >= 10) return 1;
  if (width >= 1) return 2;
  return 3;
}

function fullRange(value: unknown): [number, number] | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  const visit = (candidate: unknown) => {
    if (typeof candidate === "number") {
      if (Number.isFinite(candidate)) {
        min = Math.min(min, candidate);
        max = Math.max(max, candidate);
      }
      return;
    }
    if (typeof candidate === "bigint") {
      const numeric = Number(candidate);
      if (Number.isFinite(numeric)) {
        min = Math.min(min, numeric);
        max = Math.max(max, numeric);
      }
      return;
    }
    if (Array.isArray(candidate) || ArrayBuffer.isView(candidate)) {
      for (const item of Array.from(candidate as ArrayLike<unknown>)) visit(item);
      return;
    }
    if (candidate && typeof candidate === "object") {
      for (const item of Object.values(candidate)) visit(item);
    }
  };

  visit(value);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (min === max) {
    const padding = Math.abs(min) * 0.05 || 1;
    return [min - padding, max + padding];
  }
  return [min, max];
}

function initialDisplayRange(variable: VariableConfig): [number, number] {
  const name = `${variable.id} ${variable.label}`.toLowerCase();
  const unit = variable.unit.toLowerCase();
  if (name.includes("temperature") || name.includes("dew point")) {
    return unit.includes("celsius") || unit.includes("°c")
      ? [-40, 40]
      : [230, 320];
  }
  if (name.includes("relative humidity") || unit === "%") return [0, 100];
  if (name.includes("cloud") && (unit === "1" || unit === "")) return [0, 1];
  if (name.includes("pressure")) {
    return unit.includes("hpa") || unit.includes("millibar")
      ? [900, 1050]
      : [90_000, 105_000];
  }
  if (name.includes("precip") || name.includes("snowfall")) return [0, 25];
  if (name.includes("wind") && /\b(?:u|v)\b/.test(name)) return [-30, 30];
  if (name.includes("wind")) return [0, 30];
  if (name.includes("geopotential height")) return [0, 6_000];
  return [0, 1];
}

function displayRangeKey(datasetId: string, variableId: string) {
  return `${COLOR_RANGE_ESTIMATOR_VERSION}:${datasetId}:${variableId}`;
}

function axisSummary(
  info: StoreInfo,
  variable: VariableConfig,
  selections: AxisSelection,
) {
  return variable.dimensions.flatMap((dimension) => {
    const axis = info.axes[dimension];
    if (!axis) return [];
    return [`${axis.label}: ${formatAxisValue(info.dataset, axis, selections[dimension] ?? 0)}`];
  }).join(" · ");
}

function normalizedVariableName(variable: VariableConfig) {
  return `${variable.id} ${variable.label}`
    .toLowerCase()
    .replaceAll("metre", "m")
    .replaceAll("meter", "m")
    .replaceAll(/[^a-z0-9]+/g, "");
}

function variableConcept(variable: VariableConfig) {
  const name = normalizedVariableName(variable);
  const standardName = variable.standardName?.toLowerCase() ?? "";
  const isTwoMeter = name.includes("2m")
    || variable.id.toLowerCase() === "t2m"
    || variable.id.toLowerCase() === "d2m";
  const isDewPoint = name.includes("dew")
    || standardName.includes("dew_point")
    || variable.id.toLowerCase() === "d2m";
  if (isDewPoint) return isTwoMeter ? "dew_point_2m" : "dew_point";
  const isTemperature = name.includes("temp")
    || standardName === "air_temperature"
    || variable.id.toLowerCase() === "t2m";
  if (isTemperature) return isTwoMeter ? "air_temperature_2m" : "air_temperature";
  return undefined;
}

function matchingVariable(info: StoreInfo, source: VariableConfig) {
  const exact = info.variables.find((candidate) => candidate.id === source.id);
  if (exact) return exact;
  const standardName = source.standardName?.toLowerCase();
  const sourceName = normalizedVariableName(source);
  const sourceConcept = variableConcept(source);
  const ranked = info.variables.map((candidate) => {
    const candidateName = normalizedVariableName(candidate);
    const candidateConcept = variableConcept(candidate);
    let semanticScore = 0;
    if (sourceConcept && candidateConcept === sourceConcept) {
      semanticScore += 120;
    }
    if (
      (!sourceConcept || !candidateConcept || sourceConcept === candidateConcept)
      && standardName
      && candidate.standardName?.toLowerCase() === standardName
    ) {
      semanticScore += 100;
    }
    if (candidateName === sourceName) semanticScore += 80;
    let score = semanticScore;
    if (semanticScore > 0 && source.unit && candidate.unit === source.unit) score += 5;
    score -= candidate.dimensions.filter((dimension) => {
      const kind = info.axes[dimension]?.kind;
      return kind !== "time"
        && kind !== "timedelta"
        && !["latitude", "lat", "longitude", "lon", "x", "y"].includes(
          dimension.toLowerCase(),
        )
        && !["ensemble", "ensemble_member", "member", "sample", "number"].includes(
          dimension.toLowerCase(),
        );
    }).length * 2;
    return { candidate, score };
  }).sort((a, b) => b.score - a.score);
  return ranked[0]?.score > 0 ? ranked[0].candidate : undefined;
}

function selectedAnchorDate(
  info: StoreInfo,
  variable: VariableConfig,
  selections: AxisSelection,
) {
  const timeDimension = variable.dimensions.find(
    (dimension) => info.axes[dimension]?.kind === "time",
  );
  if (!timeDimension) return undefined;
  return axisValueAsDate(
    info.dataset,
    info.axes[timeDimension],
    selections[timeDimension] ?? 0,
  );
}

function selectedValidDate(
  info: StoreInfo,
  variable: VariableConfig,
  selections: AxisSelection,
) {
  const timeDimensions = variable.dimensions.filter(
    (dimension) => info.axes[dimension]?.kind === "time",
  );
  const validDimension = timeDimensions.find((dimension) =>
    dimension.toLowerCase().includes("valid"),
  );
  const timeDimension = validDimension
    ?? timeDimensions.find((dimension) =>
      ["init_time", "forecast_reference_time"].includes(dimension.toLowerCase()),
    )
    ?? timeDimensions[0];
  if (!timeDimension) return undefined;

  const base = axisValueAsDate(
    info.dataset,
    info.axes[timeDimension],
    selections[timeDimension] ?? 0,
  );
  if (validDimension) return base;

  const leadDimension = variable.dimensions.find(
    (dimension) => info.axes[dimension]?.kind === "timedelta",
  );
  if (!leadDimension) return base;
  return new Date(
    base.getTime()
    + timedeltaMilliseconds(
      info.axes[leadDimension],
      selections[leadDimension] ?? 0,
    ),
  );
}

export function ZarrViewer() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("maplibre-gl").Map | null>(null);
  const layerRef = useRef<import("@carbonplan/zarr-layer").ZarrLayer | null>(null);
  const infoRef = useRef<StoreInfo | null>(null);
  const variableRef = useRef<VariableConfig | null>(null);
  const selectionsRef = useRef<AxisSelection>({});
  const requestGeneration = useRef(0);
  const rangeGeneration = useRef(0);
  const needsRangeEstimateRef = useRef(true);
  const displayRangesRef = useRef(new Map<string, [number, number]>());
  const opacityRef = useRef(1);
  const legendRef = useRef<HTMLDivElement>(null);
  const inspectionPointRef = useRef<InspectionPoint | null>(null);
  const inspectionMarkerRef = useRef<import("maplibre-gl").Marker | null>(null);
  const inspectionRequestGeneration = useRef(0);
  const seriesRequestGeneration = useRef(0);
  const seriesDatasetIdsRef = useRef<string[]>([]);
  const playbackPrefetchRef = useRef<PlaybackPrefetchQueue | null>(null);
  const playbackPrefetchGenerationRef = useRef(0);
  const playbackViewportMovingRef = useRef(false);
  const resetPlaybackPrefetchRef = useRef<() => void>(() => {});
  const startSeriesComparisonRef = useRef<(point: InspectionPoint) => void>(() => {});

  const [datasetId, setDatasetId] = useState(
    () => getDataset(DEFAULT_DATASET_ID).id,
  );
  const [info, setInfo] = useState<StoreInfo | null>(null);
  const [variable, setVariable] = useState<VariableConfig | null>(null);
  const [selections, setSelections] = useState<AxisSelection>({});
  const [opacity, setOpacity] = useState(1);
  const [activeDisplayRange, setActiveDisplayRange] = useState<[number, number]>([0, 1]);
  const [colormapId, setColormapId] = useState(DEFAULT_COLORMAP.id);
  const [colormapOpen, setColormapOpen] = useState(false);
  const [editingLimit, setEditingLimit] = useState<Limit | null>(null);
  const [limitDraft, setLimitDraft] = useState("");
  const [playingAxis, setPlayingAxis] = useState<string | null>(null);
  const [playbackViewportRevision, setPlaybackViewportRevision] = useState(0);
  const [projection, setProjection] = useState<Projection>("globe");
  const [loadState, setLoadState] = useState<LoadState>(() => loadingState());
  const [mapReady, setMapReady] = useState(false);
  const [inspector, setInspector] = useState<Inspector | null>(null);
  const [seriesEntries, setSeriesEntries] = useState<ComparisonSeriesEntry[]>([]);
  const [seriesPickerId, setSeriesPickerId] = useState(
    TIME_SERIES_DATASETS[0]?.id ?? "",
  );

  const dataset = getDataset(datasetId);
  const colormap = useMemo(
    () => COLORMAPS.find((option) => option.id === colormapId) ?? DEFAULT_COLORMAP,
    [colormapId],
  );
  const legendGradient = useMemo(
    () => `linear-gradient(90deg, ${colormap.colors.join(", ")})`,
    [colormap],
  );
  const activeAxes = useMemo(() => {
    if (!info || !variable) return [];
    return variable.dimensions.flatMap((dimension) => {
      const axis = info.axes[dimension];
      return axis ? [axis] : [];
    });
  }, [info, variable]);
  const selectedMapValidDate = useMemo(
    () => info && variable
      ? selectedValidDate(info, variable, selections)
      : undefined,
    [info, selections, variable],
  );

  const resetPlaybackPrefetch = useCallback(() => {
    const queue = playbackPrefetchRef.current;
    queue?.controller.abort();
    playbackPrefetchGenerationRef.current += 1;
    playbackPrefetchRef.current = null;
  }, []);
  resetPlaybackPrefetchRef.current = resetPlaybackPrefetch;

  const ensurePlaybackPrefetch = useCallback((
    axis: AxisConfig,
    currentIndex: number,
  ): Promise<void> => {
    const layer = layerRef.current;
    const map = mapRef.current;
    const currentInfo = infoRef.current;
    const currentVariable = variableRef.current;
    if (
      !layer
      || !map
      || !currentInfo
      || !currentVariable
      || playbackViewportMovingRef.current
    ) return Promise.resolve();

    let queue = playbackPrefetchRef.current;
    if (!queue || queue.axisId !== axis.id || queue.controller.signal.aborted) {
      queue?.controller.abort();
      const profile = playbackPrefetchProfile(
        currentInfo.source,
        currentVariable,
        axis,
      );
      queue = {
        generation: ++playbackPrefetchGenerationRef.current,
        axisId: axis.id,
        ahead: profile.ahead,
        concurrency: profile.concurrency,
        directChunkReads: profile.directChunkReads,
        rampUp: true,
        controller: new AbortController(),
        ready: new Set<number>(),
        promises: new Map<number, Promise<void>>(),
        resolve: new Map<number, () => void>(),
        queued: [],
        queuedSet: new Set<number>(),
        inFlight: new Set<number>(),
        attempts: new Map<number, number>(),
      };
      playbackPrefetchRef.current = queue;
    }

    for (const index of queue.ready) {
      if (index <= currentIndex) {
        queue.ready.delete(index);
        queue.promises.delete(index);
      }
    }
    const stop = Math.min(
      axis.values.length - 1,
      currentIndex + queue.ahead,
    );
    for (let index = currentIndex + 1; index <= stop; index += 1) {
      if (
        !queue.ready.has(index)
        && !queue.queuedSet.has(index)
        && !queue.inFlight.has(index)
      ) {
        if (!queue.promises.has(index)) {
          let resolveTask = () => {};
          const promise = new Promise<void>((resolve) => {
            resolveTask = resolve;
          });
          queue.promises.set(index, promise);
          queue.resolve.set(index, resolveTask);
        }
        queue.queued.push(index);
        queue.queuedSet.add(index);
      }
    }
    queue.queued.sort((a, b) => a - b);

    const pump = () => {
      const activeQueue = playbackPrefetchRef.current;
      if (
        activeQueue !== queue
        || queue.controller.signal.aborted
        || playbackViewportMovingRef.current
      ) return;
      while (
        queue.inFlight.size < (queue.rampUp ? 1 : queue.concurrency)
        && queue.queued.length > 0
      ) {
        const index = queue.queued.shift();
        if (index === undefined) break;
        queue.queuedSet.delete(index);
        queue.inFlight.add(index);
        const generation = queue.generation;
        const attempt = (queue.attempts.get(index) ?? 0) + 1;
        queue.attempts.set(index, attempt);
        const nextSelections = {
          ...selectionsRef.current,
          [axis.id]: index,
        };
        const center = map.getCenter();
        const chunkKey = queue.directChunkReads
          ? playbackChunkKey(currentVariable, nextSelections)
          : undefined;
        const prefetchStore = currentInfo.layerOptions.store;
        let retry = false;
        const prefetch = chunkKey && prefetchStore
          ? Promise.resolve(prefetchStore.get(
              chunkKey,
              { signal: queue.controller.signal },
            )).then(() => undefined)
          : layer.queryData(
            {
              type: "Point",
              coordinates: toDataCoordinates(
                currentInfo.dataset,
                center.lng,
                center.lat,
              ),
            },
            selectorFor(currentVariable, nextSelections),
            {
              signal: queue.controller.signal,
              includeSpatialCoordinates: false,
            },
          ).then(() => undefined);
        void prefetch.then(() => {
          if (
            playbackPrefetchRef.current === queue
            && queue.generation === generation
            && !queue.controller.signal.aborted
          ) {
            queue.ready.add(index);
          }
        }).catch((error) => {
          if (
            playbackPrefetchRef.current === queue
            && queue.generation === generation
            && !queue.controller.signal.aborted
            && attempt < 2
          ) {
            retry = true;
            queue.queued.unshift(index);
            queue.queuedSet.add(index);
          } else if (
            !(error instanceof DOMException && error.name === "AbortError")
          ) {
            console.debug("Playback prefetch skipped", error);
          }
        }).finally(() => {
          if (
            playbackPrefetchRef.current !== queue
            || queue.generation !== generation
          ) return;
          queue.inFlight.delete(index);
          if (!retry) queue.rampUp = false;
          if (!retry) {
            queue.resolve.get(index)?.();
            queue.resolve.delete(index);
          }
          pump();
        });
      }
    };
    pump();
    return queue.promises.get(currentIndex + 1) ?? Promise.resolve();
  }, []);

  const loadComparisonDataset = useCallback(async (
    comparisonDatasetId: string,
    point: InspectionPoint,
    generation: number,
  ) => {
    const sourceInfo = infoRef.current;
    const sourceVariable = variableRef.current;
    if (!sourceInfo || !sourceVariable) return;
    const anchorDate = selectedAnchorDate(
      sourceInfo,
      sourceVariable,
      selectionsRef.current,
    );
    setSeriesEntries((current) => {
      const previous = current.find(
        (entry) => entry.datasetId === comparisonDatasetId,
      );
      const loading: ComparisonSeriesEntry = {
        datasetId: comparisonDatasetId,
        phase: "loading",
        message: "Opening dataset…",
        series: previous?.series,
      };
      const existing = current.findIndex(
        (entry) => entry.datasetId === comparisonDatasetId,
      );
      return existing < 0
        ? [...current, loading]
        : current.map((entry, index) => index === existing ? loading : entry);
    });

    try {
      const comparisonInfo = await loadStoreInfo(comparisonDatasetId, "series");
      if (generation !== seriesRequestGeneration.current) return;
      const comparisonVariable = matchingVariable(comparisonInfo, sourceVariable);
      if (!comparisonVariable) {
        throw new Error("No compatible variable was found");
      }
      const comparisonSelections = defaultSelections(
        comparisonInfo,
        comparisonVariable,
      );
      if (anchorDate) {
        for (const dimension of comparisonVariable.dimensions) {
          const axis = comparisonInfo.axes[dimension];
          if (axis?.kind === "time") {
            comparisonSelections[dimension] = axisIndexForDate(
              comparisonInfo.dataset,
              axis,
              anchorDate,
            );
          }
        }
      }
      setSeriesEntries((current) => current.map((entry) =>
        entry.datasetId === comparisonDatasetId
          ? {
            ...entry,
            message: isForecastSeries(comparisonInfo, comparisonVariable)
              ? "Computing ensemble quantiles…"
              : "Loading 15 days…",
          }
          : entry
      ));
      const series = await loadPointSeries(
        comparisonInfo,
        comparisonVariable,
        comparisonSelections,
        point.lng,
        point.lat,
      );
      if (generation !== seriesRequestGeneration.current) return;
      setSeriesEntries((current) => current.map((entry) =>
        entry.datasetId !== comparisonDatasetId
          ? entry
          : series
            ? {
              datasetId: comparisonDatasetId,
              phase: "ready",
              message: comparisonVariable.label,
              series,
            }
            : {
              datasetId: comparisonDatasetId,
              phase: "error",
              message: "No compatible time-series layout",
            }
      ));
    } catch (error) {
      if (generation !== seriesRequestGeneration.current) return;
      setSeriesEntries((current) => current.map((entry) =>
        entry.datasetId === comparisonDatasetId
          ? {
            datasetId: comparisonDatasetId,
            phase: "error",
            message: error instanceof Error ? error.message : String(error),
          }
          : entry
      ));
    }
  }, []);

  const startSeriesComparison = useCallback((point: InspectionPoint) => {
    const generation = ++seriesRequestGeneration.current;
    const currentInfo = infoRef.current;
    const currentVariable = variableRef.current;
    const selectedDatasetIds = seriesDatasetIdsRef.current;
    const comparisonDatasetIds = selectedDatasetIds.length
      ? selectedDatasetIds
      : (
        currentInfo
        && currentVariable
        && hasSeriesSource(currentInfo.dataset)
          ? [currentInfo.dataset.id]
          : []
      );
    seriesDatasetIdsRef.current = [...comparisonDatasetIds];
    setSeriesEntries((current) => comparisonDatasetIds.map(
      (comparisonDatasetId) => ({
        datasetId: comparisonDatasetId,
        phase: "loading",
        message: "Loading new location…",
        series: current.find(
          (entry) => entry.datasetId === comparisonDatasetId,
        )?.series,
      }),
    ));
    for (const comparisonDatasetId of comparisonDatasetIds) {
      void loadComparisonDataset(
        comparisonDatasetId,
        point,
        generation,
      );
    }
  }, [loadComparisonDataset]);
  startSeriesComparisonRef.current = startSeriesComparison;

  useEffect(() => {
    const selected = new Set(seriesEntries.map((entry) => entry.datasetId));
    if (
      !seriesPickerId
      || selected.has(seriesPickerId)
      || !TIME_SERIES_DATASETS.some((candidate) => candidate.id === seriesPickerId)
    ) {
      setSeriesPickerId(
        TIME_SERIES_DATASETS.find((candidate) => !selected.has(candidate.id))?.id ?? "",
      );
    }
  }, [seriesEntries, seriesPickerId]);

  const refreshInspection = useCallback(async (
    point: InspectionPoint,
    nextVariable = variableRef.current,
    nextSelections = selectionsRef.current,
  ) => {
    const layer = layerRef.current;
    const currentInfo = infoRef.current;
    if (!layer || !nextVariable || !currentInfo) return;
    const generation = ++inspectionRequestGeneration.current;
    try {
      const result = await layer.queryData(
        {
          type: "Point",
          coordinates: toDataCoordinates(currentInfo.dataset, point.lng, point.lat),
        },
        selectorFor(nextVariable, nextSelections),
        { includeSpatialCoordinates: false },
      );
      const value = firstFinite(result[nextVariable.id]);
      const activePoint = inspectionPointRef.current;
      if (
        generation !== inspectionRequestGeneration.current
        || !activePoint
        || activePoint.lng !== point.lng
        || activePoint.lat !== point.lat
      ) return;
      setInspector({ ...point, value: value ?? null });
    } catch (error) {
      console.debug("Point inspection skipped", error);
    }
  }, []);

  const applySelector = useCallback(async (
    nextVariable = variableRef.current,
    nextSelections = selectionsRef.current,
  ) => {
    const layer = layerRef.current;
    if (!layer || !nextVariable) return;
    const generation = ++requestGeneration.current;
    setLoadState(loadingState());
    try {
      await layer.setSelector(selectorFor(nextVariable, nextSelections));
      if (generation === requestGeneration.current) {
        setLoadState(READY_STATE);
        const point = inspectionPointRef.current;
        if (point) void refreshInspection(point, nextVariable, nextSelections);
      }
    } catch (error) {
      if (generation === requestGeneration.current) setLoadState(errorState(error));
    }
  }, [refreshInspection]);

  const estimateColorRange = useCallback(async () => {
    const layer = layerRef.current;
    const currentInfo = infoRef.current;
    const currentVariable = variableRef.current;
    if (!layer || !currentInfo || !currentVariable) return;
    const generation = ++rangeGeneration.current;
    const currentSelections = { ...selectionsRef.current };
    const currentSelector = selectorFor(currentVariable, currentSelections);
    try {
      const extents: [number, number][] = [];
      for (const geometry of FULL_IMAGE_GEOMETRIES) {
        if (generation !== rangeGeneration.current) return;
        const result = await layer.queryData(
          geometry,
          currentSelector,
          { includeSpatialCoordinates: false },
        );
        const extent = fullRange(result[currentVariable.id]);
        if (extent) extents.push(extent);
      }
      if (
        generation !== rangeGeneration.current
        || variableRef.current?.id !== currentVariable.id
      ) return;
      const rangeFromData: [number, number] | null = extents.length
        ? [
          Math.min(...extents.map(([min]) => min)),
          Math.max(...extents.map(([, max]) => max)),
        ]
        : null;
      if (!rangeFromData) return;
      displayRangesRef.current.set(
        displayRangeKey(currentInfo.dataset.id, currentVariable.id),
        rangeFromData,
      );
      setActiveDisplayRange(rangeFromData);
      layer.setClim(rangeFromData);
    } catch (error) {
      console.debug("Automatic color range sampling skipped", error);
    }
  }, []);

  useEffect(() => {
    const closeColormap = (event: PointerEvent) => {
      if (!legendRef.current?.contains(event.target as Node)) setColormapOpen(false);
    };
    document.addEventListener("pointerdown", closeColormap);
    return () => document.removeEventListener("pointerdown", closeColormap);
  }, []);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    let disposed = false;
    const initialize = async () => {
      const { default: maplibregl } = await import("maplibre-gl");
      if (disposed || !mapContainerRef.current) return;
      const styleResponse = await fetch(MAP_STYLE);
      if (!styleResponse.ok) {
        throw new Error(`Basemap style request failed (${styleResponse.status})`);
      }
      const initialStyle = await styleResponse.json() as Record<string, unknown>;
      initialStyle.projection = { type: "globe" };
      if (disposed || !mapContainerRef.current) return;
      const map = new maplibregl.Map({
        container: mapContainerRef.current,
        style: initialStyle as Exclude<
          import("maplibre-gl").MapOptions["style"],
          string | null | undefined
        >,
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        minZoom: 0.25,
        maxZoom: 8,
        attributionControl: false,
      });
      mapRef.current = map;
      map.addControl(
        new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }),
        "bottom-right",
      );
      map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

      map.on("load", () => {
        if (disposed) return;
        const firstSymbol = map.getStyle().layers?.find(
          (candidate) => candidate.type === "symbol",
        )?.id;
        map.addSource("coastline", {
          type: "geojson",
          data: `${import.meta.env.BASE_URL}coastline.geojson`,
          attribution: "Coastline © Natural Earth",
        });
        map.addLayer({
          id: "basemap-coastline",
          type: "line",
          source: "coastline",
          paint: {
            "line-color": "hsl(248, 2%, 56%)",
            "line-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.7, 4, 0.95],
            "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.8, 5, 1.15],
          },
        }, firstSymbol);
        setMapReady(true);
      });

      map.on("click", (event) => {
        const point = { lng: event.lngLat.lng, lat: event.lngLat.lat };
        inspectionPointRef.current = point;
        setInspector({ ...point, value: null });
        inspectionMarkerRef.current?.remove();
        const markerElement = document.createElement("span");
        markerElement.className = "inspection-marker";
        markerElement.setAttribute("aria-hidden", "true");
        inspectionMarkerRef.current = new maplibregl.Marker({ element: markerElement })
          .setLngLat([point.lng, point.lat])
          .addTo(map);
        void refreshInspection(point);
        startSeriesComparisonRef.current(point);
      });
      map.on("movestart", () => {
        playbackViewportMovingRef.current = true;
        resetPlaybackPrefetchRef.current();
      });
      map.on("moveend", () => {
        playbackViewportMovingRef.current = false;
        setPlaybackViewportRevision((current) => current + 1);
      });
      map.on("error", (event) => {
        const message = event.error?.message ?? "Map rendering error";
        if (!message.includes("glyph") && !message.includes("sprite")) {
          setLoadState({ phase: "error", message });
        }
      });
    };
    void initialize().catch((error) => setLoadState(errorState(error)));
    return () => {
      disposed = true;
      playbackPrefetchRef.current?.controller.abort();
      mapRef.current?.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, [refreshInspection]);

  useEffect(() => {
    if (!mapReady) return;
    let cancelled = false;
    const installDataset = async () => {
      setPlayingAxis(null);
      resetPlaybackPrefetchRef.current();
      seriesRequestGeneration.current += 1;
      setLoadState(loadingState("Opening dataset…"));
      setInfo(null);
      setVariable(null);
      const nextInfo = await loadStoreInfo(datasetId);
      if (cancelled) return;
      const nextVariable = nextInfo.variables.find(
        (candidate) => candidate.id === nextInfo.dataset.defaultVariable,
      ) ?? nextInfo.variables[0];
      const nextSelections = defaultSelections(nextInfo, nextVariable);
      const nextColormap = defaultColormap(nextVariable);
      const rangeKey = displayRangeKey(nextInfo.dataset.id, nextVariable.id);
      const cachedDisplayRange = displayRangesRef.current.get(rangeKey);
      const nextDisplayRange = cachedDisplayRange
        ? [...cachedDisplayRange] as [number, number]
        : initialDisplayRange(nextVariable);
      const map = mapRef.current;
      if (!map) return;

      if (map.getLayer(ZARR_LAYER_ID)) map.removeLayer(ZARR_LAYER_ID);
      layerRef.current = null;
      const { ZarrLayer } = await import("@carbonplan/zarr-layer");
      if (cancelled) return;
      const zarrLayer = new ZarrLayer({
        id: ZARR_LAYER_ID,
        variable: nextVariable.id,
        selector: selectorFor(nextVariable, nextSelections),
        colormap: [...nextColormap.colors],
        clim: nextDisplayRange,
        opacity: opacityRef.current,
        ...nextInfo.layerOptions,
        onLoadingStateChange: (loading) => {
          if (loading.error) setLoadState(errorState(loading.error));
          else if (loading.loading) setLoadState(loadingState());
          else setLoadState(READY_STATE);
        },
      });
      infoRef.current = nextInfo;
      variableRef.current = nextVariable;
      selectionsRef.current = nextSelections;
      layerRef.current = zarrLayer;
      setInfo(nextInfo);
      setVariable(nextVariable);
      setSelections(nextSelections);
      setColormapId(nextColormap.id);
      setActiveDisplayRange(nextDisplayRange);
      needsRangeEstimateRef.current = !cachedDisplayRange;
      const firstSymbol = map.getStyle().layers?.find(
        (candidate) => candidate.type === "symbol",
      )?.id;
      const beforeLayer = map.getLayer("basemap-coastline")
        ? "basemap-coastline"
        : firstSymbol;
      map.addLayer(
        zarrLayer as unknown as import("maplibre-gl").CustomLayerInterface,
        beforeLayer,
      );
      const point = inspectionPointRef.current;
      if (point) startSeriesComparisonRef.current(point);
    };
    void installDataset().catch((error) => {
      if (!cancelled) setLoadState(errorState(error));
    });
    return () => {
      cancelled = true;
      requestGeneration.current += 1;
      rangeGeneration.current += 1;
    };
  }, [datasetId, mapReady]);

  useEffect(() => {
    if (loadState.phase !== "ready" || !needsRangeEstimateRef.current) return;
    needsRangeEstimateRef.current = false;
    void estimateColorRange();
  }, [estimateColorRange, loadState.phase, variable]);

  useEffect(() => {
    if (
      !playingAxis
      || !info
      || !variable
      || loadState.phase !== "ready"
      || playbackViewportMovingRef.current
    ) return;
    const axis = info.axes[playingAxis];
    if (!axis) return;
    const currentIndex = selections[playingAxis] ?? 0;
    if (currentIndex >= axis.values.length - 1) {
      setPlayingAxis(null);
      return;
    }

    let cancelled = false;
    let timeout: number | undefined;
    const nextIndex = currentIndex + 1;
    const prepared = ensurePlaybackPrefetch(axis, currentIndex);
    const cadence = new Promise<void>((resolve) => {
      timeout = window.setTimeout(
        resolve,
        playbackInterval(info.dataset, axis, currentIndex, nextIndex),
      );
    });

    void Promise.all([prepared, cadence]).then(() => {
      if (
        cancelled
        || playbackViewportMovingRef.current
        || selectionsRef.current[playingAxis] !== currentIndex
      ) return;
      const nextSelections = {
        ...selectionsRef.current,
        [playingAxis]: nextIndex,
      };
      selectionsRef.current = nextSelections;
      setSelections(nextSelections);
      if (nextIndex >= axis.values.length - 1) {
        setPlayingAxis(null);
      }
      void applySelector(variable, nextSelections);
    });

    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [
    applySelector,
    ensurePlaybackPrefetch,
    info,
    loadState.phase,
    playbackViewportRevision,
    playingAxis,
    selections,
    variable,
  ]);

  useEffect(() => {
    if (!playingAxis) resetPlaybackPrefetch();
  }, [playingAxis, resetPlaybackPrefetch]);

  const changeVariable = async (id: string) => {
    const layer = layerRef.current;
    if (!info || !layer) return;
    const nextVariable = info.variables.find((candidate) => candidate.id === id);
    if (!nextVariable) return;
    const nextSelections = reconcileSelections(info, nextVariable, selectionsRef.current);
    const nextColormap = defaultColormap(nextVariable);
    const rangeKey = displayRangeKey(info.dataset.id, nextVariable.id);
    const cachedDisplayRange = displayRangesRef.current.get(rangeKey);
    const nextDisplayRange = cachedDisplayRange
      ? [...cachedDisplayRange] as [number, number]
      : initialDisplayRange(nextVariable);
    variableRef.current = nextVariable;
    selectionsRef.current = nextSelections;
    setVariable(nextVariable);
    resetPlaybackPrefetch();
    seriesRequestGeneration.current += 1;
    setSelections(nextSelections);
    setPlayingAxis(null);
    needsRangeEstimateRef.current = !cachedDisplayRange;
    setActiveDisplayRange(nextDisplayRange);
    setEditingLimit(null);
    setColormapOpen(false);
    setColormapId(nextColormap.id);
    setLoadState(loadingState());
    try {
      layer.setClim(nextDisplayRange);
      layer.setColormap([...nextColormap.colors]);
      await layer.setVariable(nextVariable.id);
      await applySelector(nextVariable, nextSelections);
      const point = inspectionPointRef.current;
      if (point) startSeriesComparisonRef.current(point);
    } catch (error) {
      setLoadState(errorState(error));
    }
  };

  const changeAxis = (axis: AxisConfig, nextIndex: number, manual = true) => {
    if (!variable) return;
    const clamped = Math.max(0, Math.min(axis.values.length - 1, nextIndex));
    const next = { ...selectionsRef.current, [axis.id]: clamped };
    selectionsRef.current = next;
    setSelections(next);
    if (manual) {
      resetPlaybackPrefetch();
      setPlayingAxis(null);
    }
    void applySelector(variable, next).then(() => {
      const point = inspectionPointRef.current;
      if (manual && axis.kind === "time" && point) {
        startSeriesComparisonRef.current(point);
      }
    });
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      const axis = activeAxes.find((candidate) =>
        candidate.kind === "time" || candidate.kind === "timedelta",
      ) ?? activeAxes[0];
      if (!axis) return;
      if (event.key === "ArrowLeft") changeAxis(axis, (selectionsRef.current[axis.id] ?? 0) - 1);
      if (event.key === "ArrowRight") changeAxis(axis, (selectionsRef.current[axis.id] ?? 0) + 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const changeProjection = (next: Projection) => {
    resetPlaybackPrefetch();
    setPlaybackViewportRevision((current) => current + 1);
    setProjection(next);
    mapRef.current?.setProjection({ type: next });
  };

  const togglePlayback = (axis: AxisConfig) => {
    resetPlaybackPrefetch();
    setPlayingAxis((current) => current === axis.id ? null : axis.id);
  };

  const changeOpacity = (next: number) => {
    opacityRef.current = next;
    setOpacity(next);
    layerRef.current?.setOpacity(next);
  };

  const changeColormap = (id: string) => {
    const next = COLORMAPS.find((option) => option.id === id);
    if (!next) return;
    setColormapId(id);
    setColormapOpen(false);
    layerRef.current?.setColormap([...next.colors]);
  };

  const beginLimitEdit = (limit: Limit) => {
    setColormapOpen(false);
    setEditingLimit(limit);
    setLimitDraft(String(limit === "min" ? activeDisplayRange[0] : activeDisplayRange[1]));
  };

  const commitLimitEdit = () => {
    if (!editingLimit) return;
    const next = Number(limitDraft);
    if (Number.isFinite(next)) {
      const updated: [number, number] = [...activeDisplayRange];
      updated[editingLimit === "min" ? 0 : 1] = next;
      if (updated[0] < updated[1]) {
        if (info && variable) {
          displayRangesRef.current.set(
            displayRangeKey(info.dataset.id, variable.id),
            updated,
          );
        }
        needsRangeEstimateRef.current = false;
        setActiveDisplayRange(updated);
        layerRef.current?.setClim(updated);
      }
    }
    setEditingLimit(null);
  };

  const clearInspection = () => {
    inspectionPointRef.current = null;
    inspectionRequestGeneration.current += 1;
    inspectionMarkerRef.current?.remove();
    inspectionMarkerRef.current = null;
    setInspector(null);
    seriesRequestGeneration.current += 1;
    seriesDatasetIdsRef.current = [];
    setSeriesEntries([]);
  };

  const addComparisonDataset = () => {
    const point = inspectionPointRef.current;
    if (!point || !seriesPickerId) return;
    if (!seriesDatasetIdsRef.current.includes(seriesPickerId)) {
      seriesDatasetIdsRef.current = [
        ...seriesDatasetIdsRef.current,
        seriesPickerId,
      ];
    }
    void loadComparisonDataset(
      seriesPickerId,
      point,
      seriesRequestGeneration.current,
    );
  };

  const removeComparisonDataset = (comparisonDatasetId: string) => {
    seriesDatasetIdsRef.current = seriesDatasetIdsRef.current.filter(
      (datasetId) => datasetId !== comparisonDatasetId,
    );
    setSeriesEntries((current) => current.filter(
      (entry) => entry.datasetId !== comparisonDatasetId,
    ));
  };

  const [legendMin, legendMax] = activeDisplayRange;
  const legendMid = (legendMin + legendMax) / 2;
  const legendDecimals = decimalsForRange(activeDisplayRange);

  return (
    <main className="viewer-shell">
      <div ref={mapContainerRef} className="map" aria-label="Interactive Zarr globe" />

      <div className="map-toolbar">
        <div className="projection-switch" aria-label="Map projection">
          <button className={projection === "globe" ? "active" : ""} onClick={() => changeProjection("globe")} type="button">Globe</button>
          <button className={projection === "mercator" ? "active" : ""} onClick={() => changeProjection("mercator")} type="button">Map</button>
        </div>
        <button className="reset-button" onClick={() => mapRef.current?.flyTo({ center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM, pitch: 0, bearing: 0, duration: 900 })} type="button">Reset</button>
      </div>

      <section className="control-panel" aria-label="Viewer controls">
        <div className={`status-indicator ${loadState.phase}`} role="status" title={loadState.message}>
          <span className="status-spinner" aria-hidden="true" />
          <span className="sr-only">{loadState.message}</span>
        </div>

        <div className="field-grid">
          <label className="field">
            <span>Dataset <em>{dataset.provider}</em></span>
            <select
              data-testid="dataset-select"
              value={datasetId}
              onChange={(event) => setDatasetId(event.target.value)}
            >
              {["Google", "dynamical.org", "Earthmover"].map((provider) => (
                <optgroup key={provider} label={provider}>
                  {MAP_DATASETS.filter((candidate) => candidate.provider === provider).map((candidate) => (
                    <option
                      key={candidate.id}
                      value={candidate.id}
                    >
                      {candidate.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <small className="dataset-chunking">{chunkingSummary(variable)}</small>
          </label>

          <label className="field">
            <span>Variable</span>
            <select
              data-testid="variable-select"
              value={variable?.id ?? ""}
              disabled={!info || !variable}
              title={variable?.label || variable?.id}
              onChange={(event) => void changeVariable(event.target.value)}
            >
              {(info?.variables ?? []).map((candidate) => (
                <option
                  key={candidate.id}
                  value={candidate.id}
                  title={candidate.label || candidate.id}
                >
                  {candidate.id}
                </option>
              ))}
            </select>
          </label>

          {activeAxes.map((axis) => {
            const selected = selections[axis.id] ?? 0;
            const canPlay = axis.kind === "time" || axis.kind === "timedelta";
            return (
              <div className="axis-control" key={axis.id}>
                <div className="axis-heading">
                  <span>{axis.label}</span>
                  <strong>{formatAxisValue(dataset, axis, selected)}</strong>
                </div>
                {axis.kind === "time" ? (
                  <input
                    className="axis-calendar"
                    aria-label={`${axis.label} calendar`}
                    data-testid={`calendar-${axis.id}`}
                    type="datetime-local"
                    step="3600"
                    value={axisDateInputValue(dataset, axis, selected)}
                    min={axisDateInputValue(dataset, axis, 0)}
                    max={axisDateInputValue(dataset, axis, axis.values.length - 1)}
                    onChange={(event) => {
                      if (!event.target.value) return;
                      const date = new Date(`${event.target.value}Z`);
                      if (!Number.isNaN(date.getTime())) {
                        changeAxis(axis, axisIndexForDate(dataset, axis, date));
                      }
                    }}
                  />
                ) : null}
                <div className={`axis-inputs ${canPlay ? "playable" : ""}`}>
                  <button type="button" disabled={selected <= 0} onClick={() => changeAxis(axis, selected - 1)} aria-label={`Previous ${axis.label}`}>←</button>
                  <input
                    aria-label={axis.label}
                    data-testid={`axis-${axis.id}`}
                    type="range"
                    min="0"
                    max={Math.max(0, axis.values.length - 1)}
                    step="1"
                    value={selected}
                    onChange={(event) => changeAxis(axis, Number(event.target.value))}
                  />
                  <button type="button" disabled={selected >= axis.values.length - 1} onClick={() => changeAxis(axis, selected + 1)} aria-label={`Next ${axis.label}`}>→</button>
                  {canPlay ? (
                    <button
                      className="play-button"
                      type="button"
                      disabled={selected >= axis.values.length - 1}
                      onClick={() => togglePlayback(axis)}
                      aria-label={playingAxis === axis.id ? `Pause ${axis.label}` : `Play ${axis.label}`}
                    >
                      {playingAxis === axis.id ? "Ⅱ" : "▶"}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>

        <div className="legend" ref={legendRef} aria-label={`${variable?.label ?? "Variable"} legend`}>
          <label className="opacity-control">
            <span>Opacity <strong>{Math.round(opacity * 100)}%</strong></span>
            <input data-testid="opacity-slider" type="range" min="0.2" max="1" step="0.05" value={opacity} onChange={(event) => changeOpacity(Number(event.target.value))} />
          </label>
          <button className="legend-bar" data-testid="colormap-trigger" type="button" style={{ background: legendGradient }} onClick={() => setColormapOpen((current) => !current)} aria-label={`Choose colormap. Current: ${colormap.label}`} aria-expanded={colormapOpen} aria-haspopup="menu" />
          {colormapOpen ? (
            <div className="colormap-menu" role="menu" aria-label="Colormaps">
              {COLORMAPS.map((option) => (
                <button key={option.id} className={option.id === colormap.id ? "active" : ""} type="button" role="menuitemradio" aria-checked={option.id === colormap.id} onClick={() => changeColormap(option.id)}>
                  <span className="colormap-swatch" style={{ background: `linear-gradient(90deg, ${option.colors.join(", ")})` }} />
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="legend-labels">
            {editingLimit === "min" ? (
              <input className="legend-limit-input" aria-label="Minimum color limit" autoFocus type="number" step="any" value={limitDraft} onChange={(event) => setLimitDraft(event.target.value)} onBlur={commitLimitEdit} onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") setEditingLimit(null);
              }} />
            ) : (
              <button className="legend-limit" type="button" onClick={() => beginLimitEdit("min")}>{legendMin.toFixed(legendDecimals)} {variable?.unit}</button>
            )}
            <span>{legendMid.toFixed(legendDecimals)}</span>
            {editingLimit === "max" ? (
              <input className="legend-limit-input" aria-label="Maximum color limit" autoFocus type="number" step="any" value={limitDraft} onChange={(event) => setLimitDraft(event.target.value)} onBlur={commitLimitEdit} onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") setEditingLimit(null);
              }} />
            ) : (
              <button className="legend-limit" type="button" onClick={() => beginLimitEdit("max")}>{legendMax.toFixed(legendDecimals)} {variable?.unit}</button>
            )}
          </div>
        </div>

        {loadState.phase === "error" ? <p className="load-error">{loadState.message}</p> : null}
      </section>

      {inspector && info && variable ? (
        <aside className="inspector" data-testid="inspector" aria-live="polite">
          <button className="inspector-close" type="button" onClick={clearInspection} aria-label="Close inspection">×</button>
          <strong>{inspector.value === null ? "—" : inspector.value.toFixed(legendDecimals)} <small>{variable.unit}</small></strong>
          <span>{shortCoordinate(inspector.lat, "N", "S")} · {shortCoordinate(inspector.lng, "E", "W")}</span>
          <span>{variable.label}</span>
          <span className="inspector-axes">{axisSummary(info, variable, selections)}</span>
          <SeriesComparison
            entries={seriesEntries}
            availableDatasets={TIME_SERIES_DATASETS}
            cursorDate={selectedMapValidDate}
            pickerId={seriesPickerId}
            onPickerChange={setSeriesPickerId}
            onAdd={addComparisonDataset}
            onRemove={removeComparisonDataset}
          />
        </aside>
      ) : null}
    </main>
  );
}
