import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  COLORMAPS,
  DEFAULT_COLORMAP,
  defaultColormap,
} from "./colormaps";
import {
  addFiniteValues,
  createFiniteValueSample,
  robustColorRange,
} from "./color-range";
import { commonVariableMatches } from "./common-variables";
import { DeferredCalendarInput } from "./components/DeferredCalendarInput";
import { ViewerOptions } from "./components/ViewerOptions";
import {
  variableLayerOptions,
  variableLayerUnit,
} from "./derived-store";
import { derivedDisplayId } from "./derived-variables";
import {
  DATASETS,
  DATASET_CATEGORY_GROUPS,
  datasetChunkingLabel,
  datasetOptionLabel,
  getDataset,
  hasMapSource,
  hasSeriesSource,
} from "./catalog";
import {
  SeriesComparison,
  type ComparisonSeriesEntry,
} from "./SeriesComparison";
import { Meteogram, type MeteogramFields } from "./Meteogram";
import {
  ASOS_MANIFEST_URL,
  ASOS_SERIES_COLOR,
  ASOS_SERIES_ID,
  asosAtTime,
  type AsosStation,
  type AsosWindow,
} from "./asos-types";
import {
  axisDateInputValue,
  axisIndexForDate,
  axisValueAsDate,
  defaultSelections,
  formatAxisValue,
  preserveForecastLeadSelection,
  reconcileSelections,
  selectionsAfterAxisChange,
  selectionsForValidDate,
  selectorFor,
  selectedValidDate,
  seriesStartDate,
  toDataCoordinates,
  validDateRange,
} from "./data/axes";
import type {
  AxisConfig,
  AxisSelection,
  PointSeries,
  StoreInfo,
  VariableConfig,
} from "./data/types";
import { isSpatialDimension } from "./data/dimensions";
import {
  loadStoreInfo,
} from "./dataset";
import {
  loadPointSeries,
  loadPointPrecipitationForecast,
  preloadPointSeriesCoordinates,
} from "./data/point-series";
import { temporalNeighborIndices } from "./temporal-prefetch";
import {
  decimalsForRange,
  displayRangeKey,
  errorState,
  firstFinite,
  formatOptionalValue,
  formatRangeValue,
  formatUtcTime,
  initialDisplayRange,
  loadingState,
  roundRangeToSignificant,
  roundToSignificant,
  type LoadState,
} from "./viewer/display";
import { VIEWER_DATA_ATTRIBUTION } from "./viewer/attribution";
import {
  playbackChunkKey,
  playbackInterval,
  playbackPrefetchProfile,
  type PlaybackPrefetchQueue,
} from "./viewer/playback";
import {
  datasetPreloadRequests,
  runDatasetPreloads,
} from "./viewer/dataset-preload";
import {
  clearRememberedDatasetForReload,
  hasRequestedDataset,
  initialDatasetId,
  initialViewerLocation,
  rememberDatasetForReload,
  storeUnitPreferences,
  storedUnitPreferences,
  viewerShareUrl,
} from "./viewer/preferences";
import {
  meteogramComparisonDatasets,
  meteogramSelectionsForInitialization,
  meteogramStartSelections,
  normalizeMeteogramPercentSeries,
  primaryMeteogramDataset,
  preferredRegionalMeteogramDataset,
  stitchMeteogramSeries,
  trimMeteogramSeries,
  type MeteogramViewMode,
} from "./viewer/meteogram";
import {
  formatAsosTime,
  shortCoordinate,
  stationFromFeature,
  type StationFeatureLike,
} from "./viewer/stations";
import { timeZoneAt } from "./viewer/time-zone";
import {
  variableFragmentShader,
  variableRenderingOptions,
} from "./viewer/rendering";
import { hrrrSmokeVariables } from "./viewer/smoke";
import {
  availableVariables,
  axisSummary,
  comparisonTimeIndex,
  isInitializationAxis,
  matchingVariable,
  seriesCoversDate,
  utcHour,
} from "./viewer/variables";
import {
  convertUnitRange,
  convertUnitValue,
  nativeUnitOption,
  precipitationRateUnitOption,
  unitKind,
  unitOptions,
  type UnitOption,
} from "./units";
import {
  disconnectGoogle,
  googleAuthSnapshot,
  hasGoogleAccessToken,
  requestGoogleAuthorization,
  subscribeGoogleAuth,
} from "./google-auth";
import {
  disconnectEcmwf,
  ecmwfAuthSnapshot,
  hasCdsApiKey,
  setCdsApiKey,
  subscribeEcmwfAuth,
} from "./ecmwf-auth";

type Projection = "globe" | "mercator";
type SeriesComparisonOptions = {
  addMapDataset?: boolean;
};
type InspectionPoint = { lng: number; lat: number };
type Inspector = InspectionPoint & {
  value: number | null;
  valueTimestamp?: number;
};
type Limit = "min" | "max";
type ShareStatus = "idle" | "copied" | "error";

const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const ZARR_LAYER_ID = "zarr-data";
const MOBILE_MAP_BOTTOM_PADDING = 160;
const ASOS_SOURCE_ID = "asos-stations";
const ASOS_DOT_LAYER_ID = "asos-station-dots";
const ASOS_HIT_LAYER_ID = "asos-station-hits";
const DEFAULT_CENTER: [number, number] = [-98, 38.5];
const DEFAULT_ZOOM = 1.75;
const MOBILE_DEFAULT_ZOOM = 1.25;
const DATASET_PRELOAD_DELAY_MS = 1_500;
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
async function navigateToIsolatedDataset(datasetId: string) {
  const serviceWorker = navigator.serviceWorker;
  if (!serviceWorker) {
    throw new Error("This browser cannot prepare the isolated HRRR decoder");
  }
  await serviceWorker.ready;
  if (!serviceWorker.controller) {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        serviceWorker.removeEventListener("controllerchange", onControllerChange);
        reject(new Error("The isolated HRRR decoder did not become ready"));
      }, 10_000);
      const onControllerChange = () => {
        if (!serviceWorker.controller) return;
        window.clearTimeout(timeout);
        serviceWorker.removeEventListener("controllerchange", onControllerChange);
        resolve();
      };
      serviceWorker.addEventListener("controllerchange", onControllerChange);
      onControllerChange();
    });
  }
  rememberDatasetForReload(datasetId);
  window.location.reload();
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through for browsers that deny the async clipboard API.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard copy was rejected");
}

export function ZarrViewer() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const forecastWorkbenchRef = useRef<HTMLDivElement>(null);
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
  const stationSearchInputRef = useRef<HTMLInputElement>(null);
  const seriesRequestGeneration = useRef(0);
  const seriesRequestControllerRef = useRef<AbortController | null>(null);
  const meteogramRequestControllerRef = useRef<AbortController | null>(null);
  const meteogramRequestGenerationRef = useRef(0);
  const pendingMobileForecastStationRef = useRef(false);
  const deepLinkAppliedRef = useRef(false);
  const urlSelectionsAppliedRef = useRef(false);
  const urlDisplayAppliedRef = useRef(false);
  const seriesDatasetIdsRef = useRef<string[]>([]);
  const asosStationRef = useRef<AsosStation | null>(null);
  const stationsVisibleRef = useRef(false);
  const viewModeRef = useRef<MeteogramViewMode>("series");
  const projectionRef = useRef<Projection>("globe");
  const shareStatusTimerRef = useRef<number | null>(null);
  const playbackPrefetchRef = useRef<PlaybackPrefetchQueue | null>(null);
  const playbackPrefetchGenerationRef = useRef(0);
  const playbackViewportMovingRef = useRef(false);
  const rememberedValidDateRef = useRef<Date | undefined>(undefined);
  const weatherNextStoreGenerationRef = useRef(0);
  const useDatasetDefaultsRef = useRef(false);
  const publicDatasetPreloadStartedRef = useRef(false);
  const datasetPreloadAuthKeysRef = useRef(new Set<string>());
  const resetPlaybackPrefetchRef = useRef<() => void>(() => {});
  const startSeriesComparisonRef = useRef<(
    point: InspectionPoint,
    options?: SeriesComparisonOptions,
  ) => void>(() => {});
  const startAsosComparisonRef = useRef<(station: AsosStation) => void>(() => {});
  const inspectLocationRef = useRef<(
    point: InspectionPoint,
    station: AsosStation | null,
  ) => void>(() => {});

  const [initialLocation] = useState(initialViewerLocation);
  const [hasExplicitDataset] = useState(hasRequestedDataset);
  const [datasetId, setDatasetId] = useState(initialDatasetId);
  const [viewMode, setViewMode] = useState<MeteogramViewMode>(
    initialLocation.mode,
  );
  const [mobileScreen, setMobileScreen] = useState<"map" | "forecast">(
    initialLocation.screen,
  );
  const [mapInstallRevision, setMapInstallRevision] = useState(0);
  const [unavailableMapDate, setUnavailableMapDate] = useState<Date | null>(null);
  const [googleAuth, setGoogleAuth] = useState(googleAuthSnapshot);
  const [ecmwfAuth, setEcmwfAuth] = useState(ecmwfAuthSnapshot);
  const [cdsKeyDraft, setCdsKeyDraft] = useState("");
  const [info, setInfo] = useState<StoreInfo | null>(null);
  const [variable, setVariable] = useState<VariableConfig | null>(null);
  const [selections, setSelections] = useState<AxisSelection>({});
  const [opacity, setOpacity] = useState(initialLocation.opacity ?? 1);
  const [activeDisplayRange, setActiveDisplayRange] = useState<[number, number]>([0, 1]);
  const [unitPreferences, setUnitPreferences] = useState<Record<string, string>>(
    storedUnitPreferences,
  );
  const [colormapId, setColormapId] = useState(
    () => COLORMAPS.some((candidate) => candidate.id === initialLocation.colormapId)
      ? initialLocation.colormapId!
      : DEFAULT_COLORMAP.id,
  );
  const [urlDisplayUnit, setUrlDisplayUnit] = useState(
    initialLocation.displayUnit,
  );
  const [colormapOpen, setColormapOpen] = useState(false);
  const [editingLimit, setEditingLimit] = useState<Limit | null>(null);
  const [limitDraft, setLimitDraft] = useState("");
  const [playingAxis, setPlayingAxis] = useState<string | null>(null);
  const [playbackViewportRevision, setPlaybackViewportRevision] = useState(0);
  const [projection, setProjection] = useState<Projection>(
    initialLocation.projection ?? "globe",
  );
  const [mobileControlsCollapsed, setMobileControlsCollapsed] = useState(
    () => typeof window !== "undefined"
      && window.matchMedia("(max-width: 960px)").matches,
  );
  const [loadState, setLoadState] = useState<LoadState>(() => loadingState());
  const [mapReady, setMapReady] = useState(false);
  const [firstDatasetFrameReady, setFirstDatasetFrameReady] = useState(false);
  const [stationsVisible, setStationsVisible] = useState(
    Boolean(initialLocation.station),
  );
  const [stationsPhase, setStationsPhase] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [stations, setStations] = useState<AsosStation[]>([]);
  const [stationSearchQuery, setStationSearchQuery] = useState("");
  const [stationSearchIndex, setStationSearchIndex] = useState(-1);
  const [asosStation, setAsosStation] = useState<AsosStation | null>(null);
  const [asosWindow, setAsosWindow] = useState<AsosWindow | null>(null);
  const [inspector, setInspector] = useState<Inspector | null>(null);
  const [seriesEntries, setSeriesEntries] = useState<ComparisonSeriesEntry[]>([]);
  const [seriesPickerId, setSeriesPickerId] = useState(
    TIME_SERIES_DATASETS[0]?.id ?? "",
  );
  const [meteogramEntries, setMeteogramEntries] = useState<
    ComparisonSeriesEntry[]
  >([]);
  const [meteogramFields, setMeteogramFields] = useState<MeteogramFields>({});
  const [meteogramPhase, setMeteogramPhase] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [meteogramMessage, setMeteogramMessage] = useState(
    "Select a station or point to load an hourly forecast.",
  );
  const [shareStatus, setShareStatus] = useState<ShareStatus>("idle");
  useEffect(() => {
    const restoreMobileScreen = () => {
      setMobileScreen(initialViewerLocation().screen);
    };
    window.addEventListener("popstate", restoreMobileScreen);
    return () => window.removeEventListener("popstate", restoreMobileScreen);
  }, []);
  useEffect(() => {
    clearRememberedDatasetForReload();
    return () => {
      if (shareStatusTimerRef.current !== null) {
        window.clearTimeout(shareStatusTimerRef.current);
      }
    };
  }, []);

  const dataset = getDataset(datasetId);
  viewModeRef.current = viewMode;
  opacityRef.current = opacity;
  projectionRef.current = projection;
  const googleAuthRequired = dataset.sources.map?.auth === "google";
  const googleConnected = googleAuth.phase === "connected"
    && hasGoogleAccessToken();
  const ecmwfAuthRequired = dataset.sources.map?.auth === "cds-api-key";
  const ecmwfConnected = hasCdsApiKey();
  const activeVariableUnit = info && variable
    ? variableLayerUnit(info, variable)
    : variable?.unit ?? "";
  const variableUnitContext = variable
    ? `${variable.id} ${variable.label} ${variable.standardName ?? ""}`
    : "";
  const availableUnitOptions = useMemo(
    () => variable ? unitOptions(activeVariableUnit, variableUnitContext) : [],
    [activeVariableUnit, variable, variableUnitContext],
  );
  const currentUnitKind = variable
    ? unitKind(activeVariableUnit, variableUnitContext)
    : undefined;
  const selectedUnit = useMemo<UnitOption | null>(() => {
    if (!variable) return null;
    const preferred = currentUnitKind
      ? unitPreferences[currentUnitKind]
      : undefined;
    return availableUnitOptions.find((option) => option.id === urlDisplayUnit)
      ?? availableUnitOptions.find((option) => option.id === preferred)
      ?? nativeUnitOption(activeVariableUnit, variableUnitContext)
      ?? availableUnitOptions[0]
      ?? null;
  }, [
    availableUnitOptions,
    currentUnitKind,
    unitPreferences,
    urlDisplayUnit,
    activeVariableUnit,
    variable,
    variableUnitContext,
  ]);
  const meteogramTemperatureUnit = useMemo(() => {
    const options = unitOptions("K", "2 metre temperature");
    const preferred = unitPreferences.temperature;
    return options.find((option) => option.id === preferred)
      ?? options.find((option) => option.id === "tempC")
      ?? options[0]
      ?? null;
  }, [unitPreferences.temperature]);
  const meteogramPrecipitationUnit = useMemo(
    () => precipitationRateUnitOption(
      currentUnitKind === "precipitation"
          || currentUnitKind === "precipitation_rate"
        ? selectedUnit?.id
        : unitPreferences.precipitation,
    ),
    [currentUnitKind, selectedUnit?.id, unitPreferences.precipitation],
  );
  const meteogramWindSpeedUnit = useMemo(() => {
    const options = unitOptions("m/s", "10 metre wind speed");
    const preferred = currentUnitKind === "speed"
      ? selectedUnit?.id
      : unitPreferences.speed;
    return options.find((option) => option.id === preferred)
      ?? options.find((option) => option.id === "m/s")
      ?? options[0]
      ?? null;
  }, [currentUnitKind, selectedUnit?.id, unitPreferences.speed]);
  const stationSearchResults = useMemo(() => {
    const query = stationSearchQuery.trim().toLocaleLowerCase();
    if (!query) return [];
    return stations
      .flatMap((station) => {
        const code = station.station.toLocaleLowerCase();
        const name = station.name.toLocaleLowerCase();
        const location = `${station.state} ${station.country}`.toLocaleLowerCase();
        const score = code === query ? 0
          : code.startsWith(query) ? 1
            : name.startsWith(query) ? 2
              : code.includes(query) ? 3
                : name.includes(query) ? 4
                  : location.includes(query) ? 5
                    : Number.POSITIVE_INFINITY;
        return Number.isFinite(score) ? [{ station, score }] : [];
      })
      .sort((first, second) =>
        first.score - second.score
        || first.station.station.localeCompare(second.station.station)
      )
      .slice(0, 7)
      .map(({ station }) => station);
  }, [stationSearchQuery, stations]);
  const colormap = useMemo(
    () => COLORMAPS.find((option) => option.id === colormapId) ?? DEFAULT_COLORMAP,
    [colormapId],
  );
  const legendGradient = useMemo(
    () => `linear-gradient(90deg, ${colormap.colors.join(", ")})`,
    [colormap],
  );

  useEffect(() => subscribeGoogleAuth(setGoogleAuth), []);
  useEffect(() => subscribeEcmwfAuth(setEcmwfAuth), []);
  useEffect(() => {
    storeUnitPreferences(unitPreferences);
  }, [unitPreferences]);
  const activeAxes = useMemo(() => {
    if (!info || !variable) return [];
    const dimensions = [
      ...Object.values(info.axes)
        .filter((axis) => axis.requiresStoreReload)
        .map((axis) => axis.id),
      ...variable.dimensions,
    ];
    return [...new Set(dimensions)].flatMap((dimension) => {
      const axis = info.axes[dimension];
      return axis ? [axis] : [];
    });
  }, [info, variable]);
  const compactPlaybackAxes = useMemo(
    () => activeAxes.filter(
      (axis) => (
        axis.kind === "time" || axis.kind === "timedelta"
      ) && !axis.requiresStoreReload,
    ),
    [activeAxes],
  );
  const backgroundPrefetchAxis = useMemo(
    () => compactPlaybackAxes.find((axis) => axis.kind === "timedelta")
      ?? compactPlaybackAxes.find((axis) => axis.kind === "time"),
    [compactPlaybackAxes],
  );
  const selectedMapValidDate = useMemo(
    () => unavailableMapDate ?? (info && variable
      ? selectedValidDate(info, variable, selections)
      : undefined),
    [info, selections, unavailableMapDate, variable],
  );
  const selectedMapInitializationTime = useMemo(() => {
    if (!info) return undefined;
    const axis = Object.values(info.axes).find(
      (candidate) => candidate.kind === "time" && isInitializationAxis(candidate),
    );
    if (!axis) return undefined;
    const timestamp = axisValueAsDate(
      info.dataset,
      axis,
      selections[axis.id] ?? axis.defaultIndex ?? 0,
    ).getTime();
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }, [info, selections]);
  const initialDatasetTargetDate = useMemo(
    () => Object.values(initialLocation.axisValues)
      .map((value) => new Date(value))
      .find((date) => Number.isFinite(date.getTime())),
    [initialLocation.axisValues],
  );
  const forecastValidDate = dataset.category === "forecast"
    && selectedMapValidDate
    && Number.isFinite(selectedMapValidDate.getTime())
    ? selectedMapValidDate
    : undefined;

  const resetPlaybackPrefetch = useCallback(() => {
    const queue = playbackPrefetchRef.current;
    for (const resolve of queue?.resolve.values() ?? []) resolve();
    queue?.resolve.clear();
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
        behind: profile.behind,
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

    const targetIndices = temporalNeighborIndices(
      currentIndex,
      axis.values.length,
      queue.ahead,
      queue.behind,
    );
    const targetSet = new Set(targetIndices);
    for (const index of queue.ready) {
      if (!targetSet.has(index)) {
        queue.ready.delete(index);
        queue.promises.delete(index);
      }
    }
    queue.queued = queue.queued.filter((index) => {
      if (targetSet.has(index)) return true;
      queue.queuedSet.delete(index);
      queue.resolve.get(index)?.();
      queue.resolve.delete(index);
      queue.promises.delete(index);
      return false;
    });
    for (const index of targetIndices) {
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
    const priority = new Map(
      targetIndices.map((index, order) => [index, order]),
    );
    queue.queued.sort(
      (a, b) => (priority.get(a) ?? Infinity) - (priority.get(b) ?? Infinity),
    );

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
        const nextSelections = selectionsAfterAxisChange(
          currentInfo,
          currentVariable,
          selectionsRef.current,
          axis,
          index,
        );
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
            console.debug("Temporal prefetch skipped", error);
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
    signal: AbortSignal,
  ) => {
    const sourceInfo = infoRef.current;
    const sourceVariable = variableRef.current;
    if (!sourceInfo || !sourceVariable) return;
    const anchorDate = selectedValidDate(
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
        series: seriesCoversDate(previous?.series, anchorDate)
          ? previous?.series
          : undefined,
      };
      const existing = current.findIndex(
        (entry) => entry.datasetId === comparisonDatasetId,
      );
      return existing < 0
        ? [...current, loading]
        : current.map((entry, index) => index === existing ? loading : entry);
    });

    try {
      const sourceInitializationAxis = comparisonDatasetId === sourceInfo.dataset.id
        ? Object.values(sourceInfo.axes).find(
          (axis) => axis.kind === "time" && isInitializationAxis(axis),
        )
        : undefined;
      const comparisonTargetDate = sourceInitializationAxis
        ? axisValueAsDate(
          sourceInfo.dataset,
          sourceInitializationAxis,
          selectionsRef.current[sourceInitializationAxis.id]
            ?? sourceInitializationAxis.defaultIndex
            ?? 0,
        )
        : anchorDate;
      const comparisonInfo = await loadStoreInfo(
        comparisonDatasetId,
        "series",
        comparisonTargetDate,
      );
      if (signal.aborted || generation !== seriesRequestGeneration.current) return;
      const comparisonVariable = matchingVariable(comparisonInfo, sourceVariable);
      if (!comparisonVariable) {
        throw new Error(
          "Point time series unavailable for this map variable",
        );
      }
      const comparisonSelections = defaultSelections(
        comparisonInfo,
        comparisonVariable,
      );
      if (anchorDate) {
        const comparisonDimensions = new Set([
          ...comparisonVariable.dimensions,
          ...Object.values(comparisonInfo.axes)
            .filter((axis) => axis.requiresStoreReload)
            .map((axis) => axis.id),
        ]);
        for (const dimension of comparisonDimensions) {
          const axis = comparisonInfo.axes[dimension];
          if (axis?.kind === "time") {
            comparisonSelections[dimension] = comparisonTimeIndex(
              comparisonInfo,
              comparisonVariable,
              axis,
              isInitializationAxis(axis)
                ? comparisonTargetDate ?? anchorDate
                : anchorDate,
            );
          }
        }
      }
      setSeriesEntries((current) => current.map((entry) =>
        entry.datasetId === comparisonDatasetId
          ? {
            ...entry,
            message: "Loading timeseries…",
          }
          : entry
      ));
      const series = await loadPointSeries(
        comparisonInfo,
        comparisonVariable,
        comparisonSelections,
        point.lng,
        point.lat,
        { signal },
      );
      if (signal.aborted || generation !== seriesRequestGeneration.current) return;
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
              ...entry,
              phase: "error",
              message: "No compatible time-series layout",
            }
      ));
    } catch (error) {
      if (signal.aborted || generation !== seriesRequestGeneration.current) return;
      setSeriesEntries((current) => current.map((entry) =>
        entry.datasetId === comparisonDatasetId
          ? {
            ...entry,
            phase: "error",
            message: error instanceof Error ? error.message : String(error),
            series: undefined,
          }
          : entry
      ));
    }
  }, []);

  const startSeriesComparison = useCallback((
    point: InspectionPoint,
    options: SeriesComparisonOptions = {},
  ) => {
    seriesRequestControllerRef.current?.abort();
    const controller = new AbortController();
    seriesRequestControllerRef.current = controller;
    const generation = ++seriesRequestGeneration.current;
    const currentInfo = infoRef.current;
    const currentVariable = variableRef.current;
    const anchorDate = currentInfo && currentVariable
      ? selectedValidDate(
        currentInfo,
        currentVariable,
        selectionsRef.current,
      )
      : undefined;
    const selectedDatasetIds = [...seriesDatasetIdsRef.current];
    const mapDatasetId = currentInfo
      && currentVariable
      && hasSeriesSource(currentInfo.dataset)
      ? currentInfo.dataset.id
      : undefined;
    if (
      options.addMapDataset
      && mapDatasetId
      && !selectedDatasetIds.includes(mapDatasetId)
    ) {
      selectedDatasetIds.push(mapDatasetId);
    }
    const comparisonDatasetIds = selectedDatasetIds.length
      ? selectedDatasetIds
      : mapDatasetId
        ? [mapDatasetId]
        : [];
    seriesDatasetIdsRef.current = [...comparisonDatasetIds];
    setSeriesEntries((current) => {
      const comparisons = comparisonDatasetIds.map((comparisonDatasetId) => ({
        datasetId: comparisonDatasetId,
        phase: "loading",
        message: "Loading new location…",
        series: (() => {
          const previous = current.find(
            (entry) => entry.datasetId === comparisonDatasetId,
          )?.series;
          return seriesCoversDate(previous, anchorDate) ? previous : undefined;
        })(),
      }) satisfies ComparisonSeriesEntry);
      const previousAsos = asosStationRef.current
        ? current.find((entry) => entry.datasetId === ASOS_SERIES_ID)
        : undefined;
      return previousAsos ? [...comparisons, previousAsos] : comparisons;
    });
    for (const comparisonDatasetId of comparisonDatasetIds) {
      void loadComparisonDataset(
        comparisonDatasetId,
        point,
        generation,
        controller.signal,
      );
    }
  }, [loadComparisonDataset]);
  startSeriesComparisonRef.current = startSeriesComparison;

  const startAsosComparison = useCallback((station: AsosStation) => {
    const currentInfo = infoRef.current;
    const currentVariable = variableRef.current;
    if (!currentInfo || !currentVariable) return;
    const generation = seriesRequestGeneration.current;
    const signal = seriesRequestControllerRef.current?.signal;
    const start = seriesStartDate(
      currentInfo,
      currentVariable,
      selectionsRef.current,
    );
    const cursor = selectedValidDate(
      currentInfo,
      currentVariable,
      selectionsRef.current,
    ) ?? start;
    const stationChanged = asosStationRef.current?.station !== station.station;
    asosStationRef.current = station;
    setAsosStation(station);
    if (stationChanged) setAsosWindow(null);
    setSeriesEntries((current) => {
      const previous = current.find(
        (entry) => entry.datasetId === ASOS_SERIES_ID,
      );
      const loading: ComparisonSeriesEntry = {
        datasetId: ASOS_SERIES_ID,
        phase: "loading",
        message: "Loading station observations…",
        label: `ASOS · ${station.station}`,
        color: ASOS_SERIES_COLOR,
        removable: false,
        series: !stationChanged && seriesCoversDate(previous?.series, start)
          ? previous?.series
          : undefined,
      };
      return [
        ...current.filter((entry) => entry.datasetId !== ASOS_SERIES_ID),
        loading,
      ];
    });

    if (!start || !cursor) {
      setSeriesEntries((current) => current.map((entry) =>
        entry.datasetId === ASOS_SERIES_ID
          ? { ...entry, phase: "error", message: "Map has no selected time" }
          : entry
      ));
      return;
    }

    void import("./asos").then(({ loadAsosWindow }) =>
      loadAsosWindow(station, start, currentVariable, { signal })
    ).then((window) => {
      if (
        signal?.aborted
        ||
        generation !== seriesRequestGeneration.current
        || asosStationRef.current?.station !== station.station
      ) return;
      setAsosWindow(window);
      setSeriesEntries((current) => current.map((entry) =>
        entry.datasetId !== ASOS_SERIES_ID
          ? entry
          : {
            ...entry,
            phase: window.series ? "ready" : "error",
            message: window.message,
            series: window.series ?? undefined,
          }
      ));
    }).catch((error) => {
      if (
        signal?.aborted
        ||
        generation !== seriesRequestGeneration.current
        || asosStationRef.current?.station !== station.station
      ) return;
      setSeriesEntries((current) => current.map((entry) =>
        entry.datasetId === ASOS_SERIES_ID
          ? {
            ...entry,
            phase: "error",
            message: error instanceof Error ? error.message : String(error),
          }
          : entry
      ));
    });
  }, []);
  startAsosComparisonRef.current = startAsosComparison;

  const loadMeteogram = useCallback(async (
    point: InspectionPoint,
    preferredDatasetId: string,
    preferredInitializationDate?: Date,
  ) => {
    meteogramRequestControllerRef.current?.abort();
    const controller = new AbortController();
    meteogramRequestControllerRef.current = controller;
    const generation = ++meteogramRequestGenerationRef.current;
    const datasets = meteogramComparisonDatasets(
      TIME_SERIES_DATASETS,
      point.lng,
      point.lat,
      preferredDatasetId,
    );
    const primary = primaryMeteogramDataset(datasets);
    setMeteogramPhase("loading");
    setMeteogramMessage("Opening the latest regional and ensemble forecasts…");
    setMeteogramFields({});
    setMeteogramEntries(datasets.map((candidate) => ({
      datasetId: candidate.id,
      label: candidate.label,
      phase: "loading",
      message: "Opening latest run…",
      removable: false,
    })));

    const loaded = new Map<string, {
      info: StoreInfo;
      selections: AxisSelection;
      temperature: VariableConfig;
      series: PointSeries;
      initializationDate?: Date;
    }>();
    await Promise.all(datasets.map(async (candidate) => {
      try {
        const initializationDate = candidate.id === preferredDatasetId
          ? preferredInitializationDate
          : undefined;
        const nextInfo = await loadStoreInfo(
          candidate.id,
          "series",
          initializationDate,
        );
        controller.signal.throwIfAborted();
        const temperature = commonVariableMatches(nextInfo.variables).find(
          (match) => match.key === "t2m",
        )?.variable;
        if (!temperature) throw new Error("2 m temperature is unavailable");
        const nextSelections = meteogramSelectionsForInitialization(
          nextInfo,
          temperature,
          initializationDate,
        );
        const series = await loadPointSeries(
          nextInfo,
          temperature,
          nextSelections,
          point.lng,
          point.lat,
          { signal: controller.signal },
        );
        if (!series) throw new Error("No compatible point forecast");
        const displaySeries = trimMeteogramSeries(
          series,
          candidate.sources.series?.meteogram?.firstLeadHour,
        );
        loaded.set(candidate.id, {
          info: nextInfo,
          selections: nextSelections,
          temperature,
          series: displaySeries,
          initializationDate,
        });
        if (
          controller.signal.aborted
          || generation !== meteogramRequestGenerationRef.current
        ) return;
        setMeteogramEntries((current) => current.map((entry) =>
          entry.datasetId === candidate.id
            ? {
              ...entry,
              phase: "ready",
              message: displaySeries.kind === "forecast"
                && displaySeries.memberCount > 1
                ? `${displaySeries.memberCount} members`
                : temperature.label,
              series: displaySeries,
            }
            : entry
        ));
      } catch (error) {
        if (
          controller.signal.aborted
          || generation !== meteogramRequestGenerationRef.current
        ) return;
        setMeteogramEntries((current) => current.map((entry) =>
          entry.datasetId === candidate.id
            ? {
              ...entry,
              phase: "error",
              message: error instanceof Error ? error.message : String(error),
            }
            : entry
        ));
      }
    }));

    if (
      controller.signal.aborted
      || generation !== meteogramRequestGenerationRef.current
    ) return;
    if (!loaded.size) {
      setMeteogramPhase(loaded.size ? "ready" : "error");
      setMeteogramMessage("No compatible forecast could be loaded for this location.");
      return;
    }

    setMeteogramMessage("Loading regional detail and ensemble guidance…");
    const fieldsByDataset = new Map<string, MeteogramFields>();
    await Promise.all(datasets.map(async (candidate) => {
      const candidateLoaded = loaded.get(candidate.id);
      if (!candidateLoaded) return;
      const {
        info: candidateInfo,
        initializationDate,
      } = candidateLoaded;
      const common = new Map(
        commonVariableMatches(candidateInfo.variables).map((match) => [
          match.key,
          match.variable,
        ]),
      );
      const derived = new Map(
        (candidateInfo.derivedVariables ?? []).flatMap((field) =>
          field.derived
            ? [[field.derived.key, field] as const]
            : []
        ),
      );
      const candidateFields: MeteogramFields = {};
      const firstLeadHour =
        candidate.sources.series?.meteogram?.firstLeadHour;
      const loadField = async (
        key: keyof MeteogramFields,
        fieldVariable: VariableConfig | undefined,
      ) => {
        if (!fieldVariable) return;
        try {
          const fieldSelections = meteogramSelectionsForInitialization(
            candidateInfo,
            fieldVariable,
            initializationDate,
          );
          const series = await loadPointSeries(
            candidateInfo,
            fieldVariable,
            fieldSelections,
            point.lng,
            point.lat,
            { signal: controller.signal },
          );
          if (series) {
            candidateFields[key] = trimMeteogramSeries(
              series,
              firstLeadHour,
            );
          }
        } catch (error) {
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            console.debug(
              `Meteogram ${candidate.id} field ${key} unavailable`,
              error,
            );
          }
        }
      };
      await Promise.all([
        (async () => {
          const precipitation = common.get("tp");
          if (!precipitation) return;
          try {
            const precipitationSelections = meteogramSelectionsForInitialization(
              candidateInfo,
              precipitation,
              initializationDate,
            );
            const result = await loadPointPrecipitationForecast(
              candidateInfo,
              precipitation,
              precipitationSelections,
              point.lng,
              point.lat,
              { signal: controller.signal },
            );
            if (result) {
              candidateFields.precipitationRate = trimMeteogramSeries(
                result.rate,
                firstLeadHour,
              );
              candidateFields.precipitationProbability = trimMeteogramSeries(
                result.probability,
                firstLeadHour,
              );
            }
          } catch (error) {
            if (!(error instanceof DOMException && error.name === "AbortError")) {
              console.debug(
                `Meteogram ${candidate.id} precipitation unavailable`,
                error,
              );
            }
          }
        })(),
        loadField("cloudCover", common.get("tcc")),
        loadField("windSpeed", derived.get("wind_speed_10m")),
        loadField("windDirection", derived.get("wind_direction_10m")),
        loadField("heatIndex", derived.get("heat_index")),
        loadField("windChill", derived.get("wind_chill")),
      ]);
      candidateFields.cloudCover = normalizeMeteogramPercentSeries(
        candidateFields.cloudCover,
      );
      candidateFields.precipitationProbability =
        normalizeMeteogramPercentSeries(
          candidateFields.precipitationProbability,
        );
      fieldsByDataset.set(candidate.id, candidateFields);
    }));
    if (
      controller.signal.aborted
      || generation !== meteogramRequestGenerationRef.current
    ) return;
    const orderedFields = datasets.flatMap((candidate) => {
      const fields = fieldsByDataset.get(candidate.id);
      return fields ? [fields] : [];
    });
    const ensembleFields = primary
      ? fieldsByDataset.get(primary.id)
      : undefined;
    const bestField = (
      key: Exclude<keyof MeteogramFields, "windSpeedDistribution">,
    ) => orderedFields.reduceRight<PointSeries | undefined>(
      (fallback, fields) => stitchMeteogramSeries(fields[key], fallback),
      undefined,
    );
    const nextFields: MeteogramFields = {
      precipitationRate: bestField("precipitationRate"),
      precipitationProbability: bestField("precipitationProbability"),
      cloudCover: bestField("cloudCover"),
      windSpeed: bestField("windSpeed"),
      windSpeedDistribution: ensembleFields?.windSpeed,
      windDirection: bestField("windDirection"),
      heatIndex: bestField("heatIndex"),
      windChill: bestField("windChill"),
    };
    setMeteogramFields(nextFields);
    setMeteogramPhase("ready");
    setMeteogramMessage(
      Object.values(nextFields).some(Boolean)
        ? "Latest forecast guidance loaded."
        : "Temperature comparison ready; auxiliary fields are unavailable.",
    );
  }, []);

  const inspectedLatitude = inspector?.lat;
  const inspectedLongitude = inspector?.lng;
  const inspectionTimeZone = useMemo(
    () => inspectedLatitude === undefined || inspectedLongitude === undefined
      ? "UTC"
      : timeZoneAt(inspectedLatitude, inspectedLongitude),
    [inspectedLatitude, inspectedLongitude],
  );
  const forecastInspectorOpen = Boolean(inspector);
  const meteogramRailOpen = Boolean(
    inspector && viewMode === "meteogram",
  );
  useEffect(() => {
    if (!mapReady) return;
    let frame = 0;
    const updateMapComposition = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const map = mapRef.current;
        if (!map) return;
        map.resize();
        const bottom = window.matchMedia("(max-width: 960px)").matches
          ? MOBILE_MAP_BOTTOM_PADDING
          : 0;
        const current = map.getPadding();
        if (
          current.top !== 0
          || current.right !== 0
          || current.bottom !== bottom
          || current.left !== 0
        ) {
          map.setPadding({ top: 0, right: 0, bottom, left: 0 });
        }
      });
    };
    updateMapComposition();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(updateMapComposition);
    if (mapContainerRef.current) {
      observer?.observe(mapContainerRef.current);
    }
    window.addEventListener("resize", updateMapComposition);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateMapComposition);
      window.cancelAnimationFrame(frame);
    };
  }, [mapReady]);

  useEffect(() => {
    if (
      viewMode !== "meteogram"
      || inspectedLatitude === undefined
      || inspectedLongitude === undefined
    ) {
      meteogramRequestControllerRef.current?.abort();
      if (
        viewMode === "series"
        && inspectedLatitude !== undefined
        && inspectedLongitude !== undefined
      ) {
        startSeriesComparisonRef.current({
          lng: inspectedLongitude,
          lat: inspectedLatitude,
        }, { addMapDataset: true });
      }
      return;
    }
    void loadMeteogram({
      lng: inspectedLongitude,
      lat: inspectedLatitude,
    }, datasetId, selectedMapInitializationTime === undefined
      ? undefined
      : new Date(selectedMapInitializationTime));
    return () => meteogramRequestControllerRef.current?.abort();
  }, [
    datasetId,
    inspectedLatitude,
    inspectedLongitude,
    loadMeteogram,
    selectedMapInitializationTime,
    viewMode,
  ]);

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
      const valueTimestamp = selectedValidDate(
        currentInfo,
        nextVariable,
        nextSelections,
      )?.getTime();
      const activePoint = inspectionPointRef.current;
      if (
        generation !== inspectionRequestGeneration.current
        || !activePoint
        || activePoint.lng !== point.lng
        || activePoint.lat !== point.lat
      ) return;
      setInspector({
        ...point,
        value: value ?? null,
        valueTimestamp: Number.isFinite(valueTimestamp)
          ? valueTimestamp
          : undefined,
      });
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
      const sample = createFiniteValueSample();
      for (const geometry of FULL_IMAGE_GEOMETRIES) {
        if (generation !== rangeGeneration.current) return;
        const result = await layer.queryData(
          geometry,
          currentSelector,
          { includeSpatialCoordinates: false },
        );
        addFiniteValues(sample, result[currentVariable.id]);
      }
      if (
        generation !== rangeGeneration.current
        || variableRef.current?.id !== currentVariable.id
      ) return;
      const estimatedRange = robustColorRange(
        sample,
        currentVariable,
        variableLayerUnit(currentInfo, currentVariable),
      );
      const rangeFromData = estimatedRange
        ? roundRangeToSignificant(estimatedRange)
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
    if (
      (googleAuthRequired && !googleConnected)
      || (ecmwfAuthRequired && !ecmwfConnected)
      || (
        dataset.sources.map?.requiresCrossOriginIsolation
        && !window.crossOriginIsolated
      )
    ) return;
    void loadStoreInfo(
      datasetId,
      "map",
      rememberedValidDateRef.current ?? initialDatasetTargetDate,
    ).catch(() => {
      // The foreground installer reports errors once the map can show them.
    });
  }, [
    datasetId,
    dataset.sources.map?.requiresCrossOriginIsolation,
    ecmwfAuthRequired,
    ecmwfConnected,
    googleAuthRequired,
    googleConnected,
    initialDatasetTargetDate,
  ]);

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
      initialStyle.projection = { type: projectionRef.current };
      if (disposed || !mapContainerRef.current) return;
      const map = new maplibregl.Map({
        container: mapContainerRef.current,
        style: initialStyle as Exclude<
          import("maplibre-gl").MapOptions["style"],
          string | null | undefined
        >,
        center: (
          initialLocation.centerLatitude !== undefined
          && initialLocation.centerLongitude !== undefined
        )
          ? [
            initialLocation.centerLongitude,
            initialLocation.centerLatitude,
          ]
          : DEFAULT_CENTER,
        zoom: initialLocation.zoom ?? (
          window.matchMedia("(max-width: 960px)").matches
            ? MOBILE_DEFAULT_ZOOM
            : DEFAULT_ZOOM
        ),
        minZoom: 0.25,
        maxZoom: 8,
        attributionControl: false,
      });
      if (window.matchMedia("(max-width: 960px)").matches) {
        map.setPadding({
          top: 0,
          right: 0,
          bottom: MOBILE_MAP_BOTTOM_PADDING,
          left: 0,
        });
      }
      mapRef.current = map;
      map.addControl(
        new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }),
        "bottom-right",
      );
      map.addControl(new maplibregl.AttributionControl({
        compact: true,
        customAttribution: VIEWER_DATA_ATTRIBUTION,
      }), "bottom-left");
      const attributionElement = map.getContainer().querySelector(
        ".maplibregl-ctrl-attrib",
      );
      attributionElement?.classList.remove("maplibregl-compact-show");
      if (attributionElement instanceof HTMLDetailsElement) {
        attributionElement.open = false;
      }
      inspectLocationRef.current = (point, station) => {
        if (!station) {
          asosStationRef.current = null;
          setAsosStation(null);
          setAsosWindow(null);
        } else {
          asosStationRef.current = station;
          setAsosStation(station);
        }
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
        if (viewModeRef.current === "series") {
          startSeriesComparisonRef.current(point);
        }
        if (station) startAsosComparisonRef.current(station);
      };

      map.on("style.load", () => {
        if (disposed) return;
        setMapReady(true);
      });

      map.on("click", (event) => {
        const stationFeature = (
          stationsVisibleRef.current
          && map.getLayer(ASOS_HIT_LAYER_ID)
        )
          ? map.queryRenderedFeatures(event.point, {
            layers: [ASOS_HIT_LAYER_ID],
          })[0]
          : undefined;
        const station = stationFeature
          ? stationFromFeature(stationFeature)
          : null;
        const point = station
          ? { lng: station.longitude, lat: station.latitude }
          : { lng: event.lngLat.lng, lat: event.lngLat.lat };
        inspectLocationRef.current(point, station);
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
      seriesRequestControllerRef.current?.abort();
      playbackPrefetchRef.current?.controller.abort();
      mapRef.current?.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, [
    initialLocation.centerLatitude,
    initialLocation.centerLongitude,
    initialLocation.zoom,
    refreshInspection,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!firstDatasetFrameReady || !map || map.getSource("coastline")) return;
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
  }, [firstDatasetFrameReady]);

  useEffect(() => {
    if (stationsVisible) stationSearchInputRef.current?.focus();
  }, [stationsVisible]);

  useEffect(() => {
    stationsVisibleRef.current = stationsVisible;
    const map = mapRef.current;
    if (!mapReady || !map) return;
    let cancelled = false;
    let pointerHandlersInstalled = false;
    const showPointer = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const restorePointer = () => {
      map.getCanvas().style.cursor = "";
    };
    const setVisibility = (visibility: "visible" | "none") => {
      for (const layerId of [ASOS_DOT_LAYER_ID, ASOS_HIT_LAYER_ID]) {
        if (map.getLayer(layerId)) {
          map.setLayoutProperty(layerId, "visibility", visibility);
        }
      }
    };
    const installPointerHandlers = () => {
      if (pointerHandlersInstalled) return;
      map.on("mouseenter", ASOS_HIT_LAYER_ID, showPointer);
      map.on("mouseleave", ASOS_HIT_LAYER_ID, restorePointer);
      pointerHandlersInstalled = true;
    };

    if (!stationsVisible) {
      setVisibility("none");
      return;
    }
    const installStations = async () => {
      if (!map.getSource(ASOS_SOURCE_ID)) {
        setStationsPhase("loading");
        const response = await fetch(ASOS_MANIFEST_URL);
        if (!response.ok) {
          throw new Error(`Station manifest request failed (${response.status})`);
        }
        const data = await response.json();
        if (cancelled) return;
        setStations((data.features ?? []).flatMap(
          (feature: StationFeatureLike) => {
            const station = stationFromFeature(feature);
            return station ? [station] : [];
          },
        ));
        map.addSource(ASOS_SOURCE_ID, {
          type: "geojson",
          data,
          promoteId: "station",
          attribution: "ASOS/AWOS observations © Iowa Environmental Mesonet",
        });
        map.addLayer({
          id: ASOS_DOT_LAYER_ID,
          type: "circle",
          source: ASOS_SOURCE_ID,
          paint: {
            "circle-radius": [
              "interpolate",
              ["linear"],
              ["zoom"],
              0,
              1.4,
              3,
              2.3,
              7,
              4,
            ],
            "circle-color": "#c9cecb",
            "circle-opacity": 0.94,
            "circle-stroke-color": "#111412",
            "circle-stroke-width": 1.15,
          },
        });
        map.addLayer({
          id: ASOS_HIT_LAYER_ID,
          type: "circle",
          source: ASOS_SOURCE_ID,
          paint: {
            "circle-radius": 9,
            "circle-color": "rgba(255, 255, 255, 0.01)",
          },
        });
      }
      if (cancelled) return;
      setVisibility("visible");
      installPointerHandlers();
      setStationsPhase("ready");
    };
    void installStations().catch((error) => {
      if (cancelled) return;
      console.debug("Station overlay unavailable", error);
      setStationsPhase("error");
    });
    return () => {
      cancelled = true;
      if (pointerHandlersInstalled) {
        map.off("mouseenter", ASOS_HIT_LAYER_ID, showPointer);
        map.off("mouseleave", ASOS_HIT_LAYER_ID, restorePointer);
        restorePointer();
      }
    };
  }, [mapReady, stationsVisible]);

  useEffect(() => {
    if (!mapReady) return;
    let cancelled = false;
    const installDataset = async () => {
      const useDatasetDefaults = useDatasetDefaultsRef.current;
      const startAtFirstLead = useDatasetDefaults || Boolean(
        initialLocation.station
        && dataset.sources.map?.meteogram?.kind === "regional",
      );
      const previousVariable = useDatasetDefaults
        ? null
        : variableRef.current;
      const previousInfo = useDatasetDefaults ? null : infoRef.current;
      const previousSelections = { ...selectionsRef.current };
      useDatasetDefaultsRef.current = false;
      weatherNextStoreGenerationRef.current += 1;
      setPlayingAxis(null);
      resetPlaybackPrefetchRef.current();
      seriesRequestControllerRef.current?.abort();
      seriesRequestGeneration.current += 1;
      setLoadState(loadingState("Opening dataset…"));
      setUnavailableMapDate(null);
      setInfo(null);
      setVariable(null);
      if (
        dataset.sources.map?.requiresCrossOriginIsolation
        && !window.crossOriginIsolated
      ) {
        setLoadState(loadingState("Preparing HRRR decoder…"));
        await navigateToIsolatedDataset(datasetId);
        return;
      }
      if (googleAuthRequired && !hasGoogleAccessToken()) {
        const map = mapRef.current;
        if (map?.getLayer(ZARR_LAYER_ID)) map.removeLayer(ZARR_LAYER_ID);
        layerRef.current = null;
        setLoadState({
          phase: "ready",
          message: "WeatherNext credentials required",
        });
        return;
      }
      if (ecmwfAuthRequired && !hasCdsApiKey()) {
        const map = mapRef.current;
        if (map?.getLayer(ZARR_LAYER_ID)) map.removeLayer(ZARR_LAYER_ID);
        layerRef.current = null;
        setLoadState({
          phase: "ready",
          message: "ECMWF CDS API key required",
        });
        return;
      }
      const nextInfo = await loadStoreInfo(
        datasetId,
        "map",
        rememberedValidDateRef.current ?? (
          !urlSelectionsAppliedRef.current
            ? initialDatasetTargetDate
            : undefined
        ),
      );
      if (cancelled) return;
      const urlRequestedVariable = !urlSelectionsAppliedRef.current
        && initialLocation.variableId
        ? availableVariables(nextInfo).find(
          (candidate) => candidate.id === initialLocation.variableId,
        )
        : undefined;
      const preservedVariable = previousVariable
        ? matchingVariable(nextInfo, previousVariable)
        : undefined;
      const nextVariable = urlRequestedVariable
        ?? preservedVariable
        ?? nextInfo.variables.find(
          (candidate) => candidate.id === nextInfo.dataset.defaultVariable,
        )
        ?? nextInfo.variables[0];
      const requestedValidDate = rememberedValidDateRef.current;
      const availableRange = validDateRange(nextInfo, nextVariable);
      let nextSelections = requestedValidDate
        ? selectionsForValidDate(
          nextInfo,
          nextVariable,
          requestedValidDate,
        )
        : defaultSelections(nextInfo, nextVariable);
      const hasRequestedLead = nextVariable.dimensions.some((dimension) =>
        nextInfo.axes[dimension]?.kind === "timedelta"
        && initialLocation.axisValues[dimension] !== undefined
      );
      if (
        !hasRequestedLead
        && previousInfo
        && previousVariable
      ) {
        nextSelections = preserveForecastLeadSelection(
          previousInfo,
          previousVariable,
          previousSelections,
          nextInfo,
          nextVariable,
          nextSelections,
        );
      }
      if (startAtFirstLead && !hasRequestedLead) {
        nextSelections = meteogramStartSelections(
          nextInfo,
          nextVariable,
          nextSelections,
        );
      }
      if (!urlSelectionsAppliedRef.current) {
        const dimensions = new Set([
          ...nextVariable.dimensions,
          ...Object.values(nextInfo.axes)
            .filter((axis) => axis.requiresStoreReload)
            .map((axis) => axis.id),
        ]);
        nextSelections = { ...nextSelections };
        for (const dimension of dimensions) {
          if (isSpatialDimension(dimension, nextInfo.source)) continue;
          const requested = initialLocation.axisValues[dimension];
          const axis = nextInfo.axes[dimension];
          if (!axis || requested === undefined) continue;
          if (axis.kind === "time") {
            const date = new Date(requested);
            if (Number.isFinite(date.getTime())) {
              nextSelections[dimension] = axisIndexForDate(
                nextInfo.dataset,
                axis,
                date,
              );
            }
            continue;
          }
          const exact = axis.values.findIndex(
            (value) => String(value) === requested,
          );
          if (exact >= 0) {
            nextSelections[dimension] = exact;
            continue;
          }
          const numeric = Number(requested);
          if (Number.isFinite(numeric)) {
            nextSelections[dimension] = axis.values.reduce<number>(
              (nearest, value, index) =>
                Math.abs(Number(value) - numeric)
                  < Math.abs(Number(axis.values[nearest]) - numeric)
                  ? index
                  : nearest,
              0,
            );
          }
        }
        urlSelectionsAppliedRef.current = true;
      }
      const urlColormap = !urlDisplayAppliedRef.current
        ? COLORMAPS.find(
          (candidate) => candidate.id === initialLocation.colormapId,
        )
        : undefined;
      const nextColormap = urlColormap ?? defaultColormap(nextVariable);
      const nextLayerUnit = variableLayerUnit(nextInfo, nextVariable);
      const rangeKey = displayRangeKey(nextInfo.dataset.id, nextVariable.id);
      const cachedDisplayRange = displayRangesRef.current.get(rangeKey);
      const urlDisplayRange = !urlDisplayAppliedRef.current
        ? initialLocation.displayRange
        : undefined;
      const nextDisplayRange = urlDisplayRange
        ? [...urlDisplayRange] as [number, number]
        : cachedDisplayRange
        ? [...cachedDisplayRange] as [number, number]
        : initialDisplayRange(nextVariable, nextLayerUnit);
      urlDisplayAppliedRef.current = true;
      const map = mapRef.current;
      if (!map) return;
      if (
        requestedValidDate
        && availableRange
        && (
          requestedValidDate.getTime() < availableRange.first.getTime()
          || requestedValidDate.getTime() > availableRange.last.getTime()
        )
      ) {
        if (map.getLayer(ZARR_LAYER_ID)) map.removeLayer(ZARR_LAYER_ID);
        layerRef.current = null;
        infoRef.current = nextInfo;
        variableRef.current = nextVariable;
        selectionsRef.current = nextSelections;
        setInfo(nextInfo);
        setVariable(nextVariable);
        setSelections(nextSelections);
        setColormapId(nextColormap.id);
        setActiveDisplayRange(nextDisplayRange);
        setUnavailableMapDate(requestedValidDate);
        setLoadState(errorState(new Error(
          `Map unavailable at ${utcHour(requestedValidDate)}`
          + ` · available ${utcHour(availableRange.first)}–${utcHour(availableRange.last)}`,
        )));
        return;
      }

      if (map.getLayer(ZARR_LAYER_ID)) map.removeLayer(ZARR_LAYER_ID);
      layerRef.current = null;
      const { ZarrLayer } = await import("@carbonplan/zarr-layer");
      const nextLayerOptions = await variableLayerOptions(
        nextInfo,
        nextVariable,
      );
      if (cancelled) return;
      const zarrLayer = new ZarrLayer({
        id: ZARR_LAYER_ID,
        variable: nextVariable.id,
        selector: selectorFor(nextVariable, nextSelections),
        colormap: [...nextColormap.colors],
        clim: nextDisplayRange,
        opacity: opacityRef.current,
        ...nextLayerOptions,
        ...variableRenderingOptions(nextVariable, nextLayerUnit),
        onLoadingStateChange: (loading) => {
          if (loading.error) setLoadState(errorState(loading.error));
          else if (loading.loading) setLoadState(loadingState());
          else {
            setLoadState(READY_STATE);
            setFirstDatasetFrameReady(true);
          }
        },
      });
      infoRef.current = nextInfo;
      variableRef.current = nextVariable;
      selectionsRef.current = nextSelections;
      rememberedValidDateRef.current = selectedValidDate(
        nextInfo,
        nextVariable,
        nextSelections,
      ) ?? rememberedValidDateRef.current;
      layerRef.current = zarrLayer;
      setInfo(nextInfo);
      setVariable(nextVariable);
      setSelections(nextSelections);
      setColormapId(nextColormap.id);
      setActiveDisplayRange(nextDisplayRange);
      needsRangeEstimateRef.current = !cachedDisplayRange && !urlDisplayRange;
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
      if (point) {
        if (viewModeRef.current === "series") {
          startSeriesComparisonRef.current(point, {
            addMapDataset: true,
          });
        }
        const station = asosStationRef.current;
        if (station) startAsosComparisonRef.current(station);
      }
    };
    void installDataset().catch((error) => {
      if (cancelled) return;
      const map = mapRef.current;
      if (map?.getLayer(ZARR_LAYER_ID)) map.removeLayer(ZARR_LAYER_ID);
      layerRef.current = null;
      infoRef.current = null;
      variableRef.current = null;
      selectionsRef.current = {};
      setInfo(null);
      setVariable(null);
      setSelections({});
      setLoadState(errorState(error));
    });
    return () => {
      cancelled = true;
      requestGeneration.current += 1;
      rangeGeneration.current += 1;
    };
  }, [
    datasetId,
    dataset.sources.map?.meteogram?.kind,
    dataset.sources.map?.requiresCrossOriginIsolation,
    ecmwfAuthRequired,
    ecmwfConnected,
    googleAuthRequired,
    googleConnected,
    initialLocation.axisValues,
    initialLocation.colormapId,
    initialLocation.displayRange,
    initialLocation.station,
    initialLocation.variableId,
    initialDatasetTargetDate,
    mapInstallRevision,
    mapReady,
  ]);

  useEffect(() => {
    if (!firstDatasetFrameReady || !info) return;
    const availableAuth = [
      ...(googleConnected ? ["google" as const] : []),
      ...(ecmwfConnected ? ["cds-api-key" as const] : []),
    ];
    const authKey = availableAuth.join(",") || "public";
    if (authKey === "public") {
      if (publicDatasetPreloadStartedRef.current) return;
    } else {
      if (datasetPreloadAuthKeysRef.current.has(authKey)) return;
    }

    const timeout = window.setTimeout(() => {
      if (authKey === "public") {
        if (publicDatasetPreloadStartedRef.current) return;
        publicDatasetPreloadStartedRef.current = true;
      } else {
        if (datasetPreloadAuthKeysRef.current.has(authKey)) return;
        datasetPreloadAuthKeysRef.current.add(authKey);
      }
      const initializationAxis = Object.values(info.axes).find(
        (axis) => axis.kind === "time" && axis.requiresStoreReload,
      );
      const activeDatasetTargetDate = initializationAxis
        ? axisValueAsDate(
          info.dataset,
          initializationAxis,
          selections[initializationAxis.id]
            ?? initializationAxis.defaultIndex
            ?? 0,
        )
        : rememberedValidDateRef.current;
      const requests = datasetPreloadRequests(DATASETS, {
        activeDatasetId: info.dataset.id,
        targetDate: rememberedValidDateRef.current,
        activeDatasetTargetDate,
        availableAuth,
      });
      void runDatasetPreloads(
        requests,
        async ({ datasetId: preloadDatasetId, role, targetDate }) => {
          const preloadInfo = await loadStoreInfo(
            preloadDatasetId,
            role,
            targetDate,
          );
          if (role === "series") {
            await preloadPointSeriesCoordinates(preloadInfo);
          }
        },
      ).then((failures) => {
        if (failures.length) {
          console.debug(
            `Background dataset preload skipped ${failures.length} store(s)`,
            failures,
          );
        }
      });
    }, DATASET_PRELOAD_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [
    firstDatasetFrameReady,
    ecmwfConnected,
    googleConnected,
    info,
    selections,
  ]);

  useEffect(() => {
    if (loadState.phase !== "ready" || !needsRangeEstimateRef.current) return;
    needsRangeEstimateRef.current = false;
    void estimateColorRange();
  }, [estimateColorRange, loadState.phase, variable]);

  useEffect(() => {
    if (
      playingAxis
      || !info
      || !variable
      || !backgroundPrefetchAxis
      || loadState.phase !== "ready"
      || playbackViewportMovingRef.current
    ) return;
    void ensurePlaybackPrefetch(
      backgroundPrefetchAxis,
      selections[backgroundPrefetchAxis.id] ?? 0,
    );
  }, [
    backgroundPrefetchAxis,
    ensurePlaybackPrefetch,
    info,
    loadState.phase,
    playbackViewportRevision,
    playingAxis,
    selections,
    variable,
  ]);

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
      const nextSelections = selectionsAfterAxisChange(
        info,
        variable,
        selectionsRef.current,
        axis,
        nextIndex,
      );
      selectionsRef.current = nextSelections;
      rememberedValidDateRef.current = selectedValidDate(
        info,
        variable,
        nextSelections,
      ) ?? rememberedValidDateRef.current;
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

  const changeVariable = async (id: string) => {
    const layer = layerRef.current;
    if (!info || !variable) return;
    const nextVariable = availableVariables(info).find(
      (candidate) => candidate.id === id,
    );
    if (!nextVariable) return;
    const currentValidDate = selectedValidDate(
      info,
      variable,
      selectionsRef.current,
    );
    const reconciledSelections = reconcileSelections(
      info,
      nextVariable,
      selectionsRef.current,
    );
    const nextSelections = currentValidDate
      ? selectionsForValidDate(
        info,
        nextVariable,
        currentValidDate,
        reconciledSelections,
      )
      : reconciledSelections;
    const nextColormap = defaultColormap(nextVariable);
    const currentLayerUnit = variableLayerUnit(info, variable);
    const nextLayerUnit = variableLayerUnit(info, nextVariable);
    const rangeKey = displayRangeKey(info.dataset.id, nextVariable.id);
    const cachedDisplayRange = displayRangesRef.current.get(rangeKey);
    const nextDisplayRange = cachedDisplayRange
      ? [...cachedDisplayRange] as [number, number]
      : initialDisplayRange(nextVariable, nextLayerUnit);
    variableRef.current = nextVariable;
    selectionsRef.current = nextSelections;
    rememberedValidDateRef.current = selectedValidDate(
      info,
      nextVariable,
      nextSelections,
    ) ?? rememberedValidDateRef.current;
    setVariable(nextVariable);
    resetPlaybackPrefetch();
    seriesRequestControllerRef.current?.abort();
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
      if (
        variable.derived
        || nextVariable.derived
        || variableFragmentShader(variable, currentLayerUnit)
          !== variableFragmentShader(nextVariable, nextLayerUnit)
      ) {
        const map = mapRef.current;
        if (!map) return;
        const generation = ++requestGeneration.current;
        const { ZarrLayer } = await import("@carbonplan/zarr-layer");
        const nextLayerOptions = await variableLayerOptions(info, nextVariable);
        if (generation !== requestGeneration.current) return;
        const nextLayer = new ZarrLayer({
          id: ZARR_LAYER_ID,
          variable: nextVariable.id,
          selector: selectorFor(nextVariable, nextSelections),
          colormap: [...nextColormap.colors],
          clim: nextDisplayRange,
          opacity: opacityRef.current,
          ...nextLayerOptions,
          ...variableRenderingOptions(nextVariable, nextLayerUnit),
          onLoadingStateChange: (loading) => {
            if (generation !== requestGeneration.current) return;
            if (loading.error) setLoadState(errorState(loading.error));
            else if (loading.loading) setLoadState(loadingState());
            else {
              setLoadState(READY_STATE);
              const point = inspectionPointRef.current;
              if (point) {
                void refreshInspection(point, nextVariable, nextSelections);
              }
            }
          },
        });
        if (map.getLayer(ZARR_LAYER_ID)) map.removeLayer(ZARR_LAYER_ID);
        const firstSymbol = map.getStyle().layers?.find(
          (candidate) => candidate.type === "symbol",
        )?.id;
        const beforeLayer = map.getLayer("basemap-coastline")
          ? "basemap-coastline"
          : firstSymbol;
        map.addLayer(
          nextLayer as unknown as import("maplibre-gl").CustomLayerInterface,
          beforeLayer,
        );
        layerRef.current = nextLayer;
      } else {
        if (!layer) throw new Error("Map layer is unavailable");
        layer.setClim(nextDisplayRange);
        layer.setColormap([...nextColormap.colors]);
        await layer.setVariable(nextVariable.id);
        await applySelector(nextVariable, nextSelections);
      }
      const point = inspectionPointRef.current;
      if (point) {
        startSeriesComparisonRef.current(point);
        const station = asosStationRef.current;
        if (station) startAsosComparisonRef.current(station);
      }
    } catch (error) {
      setLoadState(errorState(error));
    }
  };

  const changeWeatherNextInitialization = async (
    initializationDate: Date,
    desiredSelections: AxisSelection,
  ) => {
    if (!info || !variable) return;
    const generation = ++weatherNextStoreGenerationRef.current;
    setLoadState(loadingState());
    try {
      const nextInfo = await loadStoreInfo(
        info.dataset.id,
        "map",
        initializationDate,
      );
      if (generation !== weatherNextStoreGenerationRef.current) return;
      const nextVariable = availableVariables(nextInfo).find(
        (candidate) => candidate.id === variable.id,
      ) ?? nextInfo.variables.find(
        (candidate) => candidate.id === nextInfo.dataset.defaultVariable,
      ) ?? nextInfo.variables[0];
      const nextLayerUnit = variableLayerUnit(nextInfo, nextVariable);
      const physicalSelections = { ...desiredSelections };
      for (const axis of Object.values(nextInfo.axes)) {
        if (axis.requiresStoreReload) delete physicalSelections[axis.id];
      }
      const reconciled = reconcileSelections(
        nextInfo,
        nextVariable,
        physicalSelections,
      );
      const nextSelections = rememberedValidDateRef.current
        ? selectionsForValidDate(
          nextInfo,
          nextVariable,
          rememberedValidDateRef.current,
          reconciled,
        )
        : reconciled;
      const map = mapRef.current;
      if (!map) return;
      const { ZarrLayer } = await import("@carbonplan/zarr-layer");
      const nextLayerOptions = await variableLayerOptions(
        nextInfo,
        nextVariable,
      );
      if (generation !== weatherNextStoreGenerationRef.current) return;
      const nextLayer = new ZarrLayer({
        id: ZARR_LAYER_ID,
        variable: nextVariable.id,
        selector: selectorFor(nextVariable, nextSelections),
        colormap: [...colormap.colors],
        clim: activeDisplayRange,
        opacity: opacityRef.current,
        ...nextLayerOptions,
        ...variableRenderingOptions(nextVariable, nextLayerUnit),
        onLoadingStateChange: (loading) => {
          if (generation !== weatherNextStoreGenerationRef.current) return;
          if (loading.error) setLoadState(errorState(loading.error));
          else if (loading.loading) setLoadState(loadingState());
          else setLoadState(READY_STATE);
        },
      });
      if (map.getLayer(ZARR_LAYER_ID)) map.removeLayer(ZARR_LAYER_ID);
      const firstSymbol = map.getStyle().layers?.find(
        (candidate) => candidate.type === "symbol",
      )?.id;
      const beforeLayer = map.getLayer("basemap-coastline")
        ? "basemap-coastline"
        : firstSymbol;
      map.addLayer(
        nextLayer as unknown as import("maplibre-gl").CustomLayerInterface,
        beforeLayer,
      );
      layerRef.current = nextLayer;
      infoRef.current = nextInfo;
      variableRef.current = nextVariable;
      selectionsRef.current = nextSelections;
      rememberedValidDateRef.current = selectedValidDate(
        nextInfo,
        nextVariable,
        nextSelections,
      ) ?? rememberedValidDateRef.current;
      setInfo(nextInfo);
      setVariable(nextVariable);
      setSelections(nextSelections);
      const point = inspectionPointRef.current;
      if (point) {
        startSeriesComparisonRef.current(point);
        const station = asosStationRef.current;
        if (station) startAsosComparisonRef.current(station);
      }
    } catch (error) {
      if (generation === weatherNextStoreGenerationRef.current) {
        setLoadState(errorState(error));
      }
    }
  };

  const changeAxis = (axis: AxisConfig, nextIndex: number, manual = true) => {
    if (!info || !variable) return;
    const clamped = Math.max(0, Math.min(axis.values.length - 1, nextIndex));
    const next = selectionsAfterAxisChange(
      info,
      variable,
      selectionsRef.current,
      axis,
      clamped,
    );
    selectionsRef.current = next;
    rememberedValidDateRef.current = selectedValidDate(info, variable, next)
      ?? rememberedValidDateRef.current;
    setSelections(next);
    if (manual) {
      resetPlaybackPrefetch();
      setPlayingAxis(null);
    }
    if (unavailableMapDate) {
      if (axis.kind === "time" || axis.kind === "timedelta") {
        const nextValidDate = selectedValidDate(info, variable, next);
        if (nextValidDate) {
          rememberedValidDateRef.current = nextValidDate;
          setUnavailableMapDate(null);
          setMapInstallRevision((current) => current + 1);
        }
      }
      return;
    }
    if (axis.requiresStoreReload) {
      void changeWeatherNextInitialization(
        axisValueAsDate(info.dataset, axis, clamped),
        next,
      );
      return;
    }
    void applySelector(variable, next).then(() => {
      const point = inspectionPointRef.current;
      if (manual && axis.kind === "time" && point) {
        startSeriesComparisonRef.current(point);
        const station = asosStationRef.current;
        if (station) startAsosComparisonRef.current(station);
      }
    });
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      const axis = activeAxes.find((candidate) =>
        candidate.kind === "timedelta" && !candidate.requiresStoreReload
      ) ?? activeAxes.find((candidate) =>
        candidate.kind === "time" && !candidate.requiresStoreReload
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

  const changeDataset = (nextDatasetId: string) => {
    const currentInfo = infoRef.current;
    const currentVariable = variableRef.current;
    if (unavailableMapDate) {
      rememberedValidDateRef.current = unavailableMapDate;
    } else if (currentInfo && currentVariable) {
      rememberedValidDateRef.current = selectedValidDate(
        currentInfo,
        currentVariable,
        selectionsRef.current,
      ) ?? rememberedValidDateRef.current;
    }
    weatherNextStoreGenerationRef.current += 1;
    const nextDataset = getDataset(nextDatasetId);
    setDatasetId(nextDataset.id);
  };

  const toggleGoogleAuthorization = async () => {
    if (googleAuth.phase === "connected") {
      disconnectGoogle();
      return;
    }
    try {
      await requestGoogleAuthorization();
    } catch {
      // The auth control displays popup and consent errors without replacing
      // the map's independent loading state.
    }
  };

  const submitCdsApiKey = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      setCdsApiKey(cdsKeyDraft);
      setCdsKeyDraft("");
    } catch {
      // The auth control remains visible so the key can be corrected.
    }
  };

  const forgetCdsApiKey = () => {
    disconnectEcmwf();
    setCdsKeyDraft("");
  };

  const togglePlayback = (axis: AxisConfig) => {
    if (playingAxis === axis.id) {
      setPlayingAxis(null);
      return;
    }
    if (playbackPrefetchRef.current?.axisId !== axis.id) {
      resetPlaybackPrefetch();
    }
    setPlayingAxis(axis.id);
  };

  const changeOpacity = (next: number) => {
    const clamped = Math.round(Math.max(0.2, Math.min(1, next)) * 100) / 100;
    opacityRef.current = clamped;
    setOpacity(clamped);
    layerRef.current?.setOpacity(clamped);
  };

  const chooseStation = useCallback((
    station: AsosStation,
    preserveMapCamera = false,
  ) => {
    const map = mapRef.current;
    if (!map) return;
    const point = { lng: station.longitude, lat: station.latitude };
    setStationSearchQuery("");
    setStationSearchIndex(-1);
    if (!preserveMapCamera) {
      map.flyTo({
        center: [station.longitude, station.latitude],
        zoom: Math.max(map.getZoom(), 5),
        duration: 700,
      });
    }
    inspectLocationRef.current(point, station);
    if (pendingMobileForecastStationRef.current) {
      pendingMobileForecastStationRef.current = false;
      setViewMode("series");
      setMobileControlsCollapsed(true);
      window.history.pushState(null, "", window.location.href);
      setMobileScreen("forecast");
    }
  }, []);

  useEffect(() => {
    if (deepLinkAppliedRef.current || !mapReady) return;
    if (initialLocation.station) {
      if (stationsPhase !== "ready") return;
      const requested = initialLocation.station.toUpperCase();
      const station = stations.find((candidate) => {
        const code = candidate.station.toUpperCase();
        return code === requested
          || code.replace(/^K(?=[A-Z]{3}$)/, "") === requested;
      });
      deepLinkAppliedRef.current = true;
      if (station) {
        const preferredDataset = hasExplicitDataset
          ? undefined
          : preferredRegionalMeteogramDataset(
            MAP_DATASETS,
            station.longitude,
            station.latitude,
          );
        if (preferredDataset) {
          useDatasetDefaultsRef.current = true;
          setDatasetId(preferredDataset.id);
        }
        chooseStation(
          station,
          initialLocation.centerLatitude !== undefined
            && initialLocation.centerLongitude !== undefined,
        );
      }
      return;
    }
    if (
      initialLocation.latitude !== undefined
      && initialLocation.longitude !== undefined
    ) {
      deepLinkAppliedRef.current = true;
      const point = {
        lat: Math.max(-90, Math.min(90, initialLocation.latitude)),
        lng: ((initialLocation.longitude + 540) % 360) - 180,
      };
      if (
        initialLocation.centerLatitude === undefined
        || initialLocation.centerLongitude === undefined
      ) {
        mapRef.current?.jumpTo({
          center: [point.lng, point.lat],
          zoom: Math.max(mapRef.current.getZoom(), 5),
        });
      }
      inspectLocationRef.current(point, null);
      return;
    }
    deepLinkAppliedRef.current = true;
  }, [
    initialLocation,
    mapReady,
    stations,
    stationsPhase,
    chooseStation,
    hasExplicitDataset,
  ]);

  const copyShareUrl = async () => {
    const map = mapRef.current;
    if (!info || !variable || !map) return;
    const center = map.getCenter();
    const station = asosStation?.station
      ?? (!deepLinkAppliedRef.current ? initialLocation.station : undefined);
    const dimensions = new Set([
      ...variable.dimensions,
      ...Object.values(info.axes)
        .filter((axis) => axis.requiresStoreReload)
        .map((axis) => axis.id),
    ]);
    const axisValues = Object.fromEntries(
      Array.from(dimensions).flatMap((dimension) => {
        if (isSpatialDimension(dimension, info.source)) return [];
        const axis = info.axes[dimension];
        const index = selections[dimension];
        if (!axis || index === undefined) return [];
        if (axis.kind === "time") {
          const date = axisValueAsDate(info.dataset, axis, index);
          return Number.isFinite(date.getTime())
            ? [[dimension, date.toISOString()]]
            : [];
        }
        const value = axis.values[index];
        return value === undefined ? [] : [[dimension, String(value)]];
      }),
    );
    const url = viewerShareUrl(window.location.href, {
      datasetId,
      mode: viewMode,
      screen: mobileScreen,
      station,
      latitude: station ? undefined : inspector?.lat,
      longitude: station ? undefined : inspector?.lng,
      centerLatitude: center.lat,
      centerLongitude: center.lng,
      zoom: map.getZoom(),
      variableId: variable.id,
      axisValues,
      colormapId,
      opacity,
      displayUnit: selectedUnit?.id,
      displayRange: activeDisplayRange,
      projection,
    });
    try {
      await copyTextToClipboard(url);
      setShareStatus("copied");
    } catch {
      setShareStatus("error");
    }
    if (shareStatusTimerRef.current !== null) {
      window.clearTimeout(shareStatusTimerRef.current);
    }
    shareStatusTimerRef.current = window.setTimeout(() => {
      setShareStatus("idle");
      shareStatusTimerRef.current = null;
    }, 2_000);
  };

  const changeDisplayUnit = (next: string) => {
    if (!currentUnitKind) return;
    setUrlDisplayUnit(next);
    setUnitPreferences((current) => ({
      ...current,
      [currentUnitKind]: next,
    }));
    setEditingLimit(null);
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
    setLimitDraft(String(roundToSignificant(
      limit === "min" ? legendMin : legendMax,
    )));
  };

  const commitLimitEdit = () => {
    if (!editingLimit) return;
    const next = Number(limitDraft);
    if (Number.isFinite(next) && variable) {
      const updated: [number, number] = [legendMin, legendMax];
      updated[editingLimit === "min" ? 0 : 1] = next;
      if (updated[0] < updated[1]) {
        const rawUpdated = roundRangeToSignificant(selectedUnit
          ? convertUnitRange(
            updated,
            selectedUnit.id,
            activeVariableUnit,
            variableUnitContext,
          )
          : updated);
        if (info && variable) {
          displayRangesRef.current.set(
            displayRangeKey(info.dataset.id, variable.id),
            rawUpdated,
          );
        }
        needsRangeEstimateRef.current = false;
        setActiveDisplayRange(rawUpdated);
        layerRef.current?.setClim(rawUpdated);
      }
    }
    setEditingLimit(null);
  };

  const clearInspection = () => {
    inspectionPointRef.current = null;
    asosStationRef.current = null;
    inspectionRequestGeneration.current += 1;
    inspectionMarkerRef.current?.remove();
    inspectionMarkerRef.current = null;
    setInspector(null);
    setAsosStation(null);
    setAsosWindow(null);
    seriesRequestGeneration.current += 1;
    seriesRequestControllerRef.current?.abort();
    meteogramRequestGenerationRef.current += 1;
    meteogramRequestControllerRef.current?.abort();
    seriesDatasetIdsRef.current = [];
    setSeriesEntries([]);
    setMeteogramEntries([]);
    setMeteogramFields({});
    setMeteogramPhase("idle");
    setMeteogramMessage("Select a station or point to load an hourly forecast.");
    setMobileScreen("map");
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
    let controller = seriesRequestControllerRef.current;
    if (!controller || controller.signal.aborted) {
      controller = new AbortController();
      seriesRequestControllerRef.current = controller;
    }
    void loadComparisonDataset(
      seriesPickerId,
      point,
      seriesRequestGeneration.current,
      controller.signal,
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

  const [legendMin, legendMax] = variable && selectedUnit
    ? convertUnitRange(
      activeDisplayRange,
      activeVariableUnit,
      selectedUnit.id,
      variableUnitContext,
    )
    : activeDisplayRange;
  const legendMid = (legendMin + legendMax) / 2;
  const legendDecimals = decimalsForRange([legendMin, legendMax]);
  const displayUnitLabel = selectedUnit?.label ?? activeVariableUnit;
  const inspectorDisplayValue = (
    inspector?.value !== null
    && inspector?.value !== undefined
    && variable
    && selectedUnit
  )
    ? convertUnitValue(
      inspector.value,
      activeVariableUnit,
      selectedUnit.id,
      variableUnitContext,
    )
    : inspector?.value;
  const formattedInspectorDisplayValue =
    typeof inspectorDisplayValue === "number"
      ? formatRangeValue(inspectorDisplayValue, [legendMin, legendMax])
      : "—";
  const currentAsos = asosAtTime(asosWindow, selectedMapValidDate);
  const commonVariables = commonVariableMatches(info?.variables ?? []);
  const smokeVariables = hrrrSmokeVariables(
    info?.dataset.id,
    info?.variables ?? [],
  );
  const derivedVariables = info?.derivedVariables ?? [];
  const asosDisplayValue = (
    currentAsos.value !== null
    && asosWindow?.unit
    && selectedUnit
  )
    ? convertUnitValue(
      currentAsos.value,
      asosWindow.unit,
      selectedUnit.id,
      variableUnitContext,
    )
    : currentAsos.value;
  const gridStationBias = (
    typeof inspectorDisplayValue === "number"
    && typeof asosDisplayValue === "number"
  )
    ? inspectorDisplayValue - asosDisplayValue
    : null;
  const asosDisplayUnit = selectedUnit?.label ?? asosWindow?.unit ?? "";
  const inspectionLocationLabel = inspector
    ? asosStation
      ? `${asosStation.station} · ${asosStation.name}`
      : `${shortCoordinate(inspector.lat, "N", "S")} · ${
        shortCoordinate(inspector.lng, "E", "W")
      }`
    : "";
  const mobileMapAxis = backgroundPrefetchAxis;
  const mobileMapAxisSelected = mobileMapAxis
    ? selections[mobileMapAxis.id] ?? 0
    : 0;
  const mobileMapValueLabel = (
    typeof inspectorDisplayValue === "number"
  )
    ? `${formattedInspectorDisplayValue} ${displayUnitLabel}`
    : inspector
      ? "—"
      : "";
  const changeMobileScreen = (next: "map" | "forecast") => {
    if (next === mobileScreen) return;
    window.history.pushState(null, "", window.location.href);
    setMobileScreen(next);
  };
  const showMobileMap = () => {
    pendingMobileForecastStationRef.current = false;
    changeMobileScreen("map");
    setMobileControlsCollapsed(true);
  };
  const showMobileForecast = () => {
    if (!inspector) {
      pendingMobileForecastStationRef.current = true;
      changeMobileScreen("map");
      setMobileControlsCollapsed(true);
      setStationsVisible(true);
      window.requestAnimationFrame(() => {
        stationSearchInputRef.current?.focus();
      });
      return;
    }
    setViewMode("series");
    changeMobileScreen("forecast");
    setMobileControlsCollapsed(true);
  };
  return (
    <main
      className={[
        "viewer-shell",
        forecastInspectorOpen ? "inspector-open" : "",
        meteogramRailOpen ? "meteogram-open" : "",
        `mobile-screen-${mobileScreen}`,
        mobileControlsCollapsed ? "mobile-layers-closed" : "mobile-layers-open",
      ].filter(Boolean).join(" ")}
    >
      <div ref={mapContainerRef} className="map" aria-label="Interactive Zarr globe" />

      <div className="map-toolbar">
        <button
          className={`station-toggle ${stationsVisible ? "active" : ""} ${stationsPhase}`}
          type="button"
          aria-pressed={stationsVisible}
          title={stationsPhase === "error"
            ? "Station overlay could not be loaded"
            : "Show ASOS/AWOS observation stations"}
          onClick={() => setStationsVisible((current) => !current)}
        >
          <i aria-hidden="true" />
          Stations
        </button>
        {stationsVisible ? (
          <div className="station-search">
            <input
              ref={stationSearchInputRef}
              type="search"
              value={stationSearchQuery}
              placeholder={stationsPhase === "loading"
                ? "Loading stations…"
                : "Find station…"}
              role="combobox"
              aria-autocomplete="list"
              aria-label="Find ASOS or AWOS station"
              aria-busy={stationsPhase === "loading"}
              aria-controls="station-search-results"
              aria-expanded={Boolean(
                stationSearchQuery.trim() && stationsPhase === "ready",
              )}
              aria-activedescendant={
                stationSearchIndex >= 0
                && stationSearchResults[stationSearchIndex]
                ? `station-search-option-${stationSearchResults[stationSearchIndex]?.station}`
                : undefined
              }
              onChange={(event) => {
                setStationSearchQuery(event.target.value);
                setStationSearchIndex(-1);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" && stationSearchResults.length) {
                  event.preventDefault();
                  setStationSearchIndex((current) =>
                    current < 0
                      ? 0
                      : (current + 1) % stationSearchResults.length
                  );
                }
                if (event.key === "ArrowUp" && stationSearchResults.length) {
                  event.preventDefault();
                  setStationSearchIndex((current) =>
                    current <= 0
                      ? stationSearchResults.length - 1
                      : current - 1
                  );
                }
                if (event.key === "Escape") {
                  setStationSearchQuery("");
                  setStationSearchIndex(-1);
                }
                if (event.key === "Enter") {
                  const station = stationSearchResults[
                    stationSearchIndex >= 0 ? stationSearchIndex : 0
                  ];
                  if (station) {
                    event.preventDefault();
                    chooseStation(station);
                  }
                }
              }}
            />
            {stationSearchQuery.trim() && stationsPhase === "ready" ? (
              <div
                id="station-search-results"
                className="station-search-results"
                role="listbox"
                aria-label="Station results"
              >
                {stationSearchResults.length ? stationSearchResults.map((station, index) => (
                  <button
                    key={station.station}
                    id={`station-search-option-${station.station}`}
                    className={index === stationSearchIndex ? "active" : ""}
                    type="button"
                    role="option"
                    aria-selected={index === stationSearchIndex}
                    onMouseEnter={() => setStationSearchIndex(index)}
                    onFocus={() => setStationSearchIndex(index)}
                    onClick={() => chooseStation(station)}
                  >
                    <strong>{station.station}</strong>
                    <span>{station.name}</span>
                    <small>
                      {[station.state, station.country].filter(Boolean).join(", ")}
                    </small>
                  </button>
                )) : (
                  <small className="station-search-empty">No matching stations</small>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
        <ViewerOptions
          className="toolbar-viewer-options"
          projection={projection}
          shareStatus={shareStatus}
          shareDisabled={!info || !variable}
          onProjectionChange={changeProjection}
          onResetView={() => mapRef.current?.flyTo({
            center: DEFAULT_CENTER,
            zoom: DEFAULT_ZOOM,
            pitch: 0,
            bearing: 0,
            duration: 900,
          })}
          onShare={() => void copyShareUrl()}
        />
      </div>

      <div
        ref={forecastWorkbenchRef}
        className={`forecast-workbench ${
          forecastInspectorOpen ? "with-inspector " : ""
        }${
          meteogramRailOpen ? "with-meteogram" : ""
        }`}
      >
      <section
        className={`control-panel ${mobileControlsCollapsed ? "mobile-compact" : ""}`}
        aria-label="Viewer controls"
      >
        <button
          className="mobile-panel-toggle"
          type="button"
          aria-expanded={!mobileControlsCollapsed}
          aria-label={mobileControlsCollapsed
            ? "Show full viewer controls"
            : "Close layer controls"}
          title={mobileControlsCollapsed
            ? "Show full controls"
            : "Close layer controls"}
          onClick={() => setMobileControlsCollapsed((current) => !current)}
        >
          {mobileControlsCollapsed ? "Layers" : "Done"}
        </button>
        <div className="field-grid">
          <label className="field selector-field dataset-field">
            <span className="dataset-heading">
              <span className="dataset-title">
                <span>Dataset</span>
                <span
                  className={`status-indicator ${loadState.phase}`}
                  role="status"
                  title={loadState.message}
                >
                  <span className="status-spinner" aria-hidden="true" />
                  <span className="sr-only">{loadState.message}</span>
                </span>
              </span>
              <small className="dataset-chunking">
                {datasetChunkingLabel(dataset)}
              </small>
            </span>
            <select
              data-testid="dataset-select"
              value={datasetId}
              onChange={(event) => changeDataset(event.target.value)}
            >
              {DATASET_CATEGORY_GROUPS.map((group) => (
                <optgroup key={group.id} label={group.label}>
                  {MAP_DATASETS.filter(
                    (candidate) => candidate.category === group.id,
                  ).map((candidate) => (
                    <option
                      key={candidate.id}
                      value={candidate.id}
                    >
                      {datasetOptionLabel(candidate)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {googleAuthRequired ? (
              <div className={`google-auth-control ${googleAuth.phase}`}>
                <button
                  type="button"
                  disabled={googleAuth.phase === "connecting"}
                  onClick={() => void toggleGoogleAuthorization()}
                  title={googleAuth.phase === "connected"
                    ? "Forget the saved WeatherNext credentials"
                    : googleAuth.message}
                >
                  <i aria-hidden="true" />
                  {googleAuth.phase === "connected"
                    ? "WeatherNext Authenticated"
                    : googleAuth.phase === "connecting"
                      ? "Authenticating…"
                      : "WeatherNext Credentials"}
                </button>
                {googleAuth.phase === "error" ? (
                  <small>{googleAuth.message}</small>
                ) : null}
              </div>
            ) : null}
            {ecmwfAuthRequired ? (
              <form
                className={`cds-auth-control ${ecmwfAuth.phase}`}
                onSubmit={submitCdsApiKey}
              >
                {ecmwfConnected ? (
                  <button
                    type="button"
                    onClick={forgetCdsApiKey}
                    title="Forget the CDS API key saved in this browser"
                  >
                    <i aria-hidden="true" />
                    CDS API key configured
                  </button>
                ) : (
                  <div>
                    <input
                      type="password"
                      value={cdsKeyDraft}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="CDS API key"
                      aria-label="ECMWF CDS API key"
                      onChange={(event) => setCdsKeyDraft(event.target.value)}
                    />
                    <button type="submit" disabled={!cdsKeyDraft.trim()}>
                      Connect
                    </button>
                  </div>
                )}
                <small>
                  {ecmwfAuth.phase === "error"
                    ? ecmwfAuth.message
                    : ecmwfConnected
                      ? "Saved only in this browser. Click to forget."
                      : "Available from your Copernicus CDS profile."}
                </small>
              </form>
            ) : null}
          </label>

          <div className="field selector-field variable-field">
            <label className="field-heading" htmlFor="variable-select">
              Variable
            </label>
            <select
              id="variable-select"
              data-testid="variable-select"
              value={variable?.id ?? ""}
              disabled={!info || !variable}
              title={variable?.label || variable?.id}
              onChange={(event) => void changeVariable(event.target.value)}
            >
              {commonVariables.length ? (
                <optgroup label="Common variables">
                  {commonVariables.map(({ key, variable: candidate }) => (
                    <option
                      key={`common-${key}`}
                      value={candidate.id}
                      title={candidate.label || candidate.id}
                    >
                      {key === candidate.id ? candidate.id : `${key} · ${candidate.id}`}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {smokeVariables.length ? (
                <optgroup label="Smoke variables (HRRR)">
                  {smokeVariables.map((candidate) => (
                    <option
                      key={`smoke-${candidate.id}`}
                      value={candidate.id}
                      title={candidate.label || candidate.id}
                    >
                      {candidate.id}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {derivedVariables.length ? (
                <optgroup label="Derived variables">
                  {derivedVariables.map((candidate) => (
                    <option
                      key={candidate.id}
                      value={candidate.id}
                      title={candidate.label}
                    >
                      {derivedDisplayId(candidate)}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              <optgroup label="All variables">
                {(info?.variables ?? []).map((candidate) => (
                  <option
                    key={candidate.id}
                    value={candidate.id}
                    title={candidate.label || candidate.id}
                  >
                    {candidate.id}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>

          {activeAxes.map((axis) => {
            const selected = selections[axis.id] ?? 0;
            const showsUnavailableAnalysisDate = Boolean(
              unavailableMapDate
              && dataset.category === "analysis"
              && axis.kind === "time",
            );
            const canPlay = (
              axis.kind === "time" || axis.kind === "timedelta"
            ) && !axis.requiresStoreReload && !unavailableMapDate;
            return (
              <div
                className={`axis-control ${
                  axis.kind === "time" ? "with-calendar" : ""
                }`}
                key={axis.id}
              >
                <div className="axis-heading">
                  <span>
                    {axis.requiresStoreReload ? "Initialization" : axis.label}
                  </span>
                  <strong>
                    {showsUnavailableAnalysisDate && unavailableMapDate
                      ? formatUtcTime(unavailableMapDate)
                      : formatAxisValue(dataset, axis, selected)}
                  </strong>
                </div>
                {axis.kind === "time" ? (
                  <DeferredCalendarInput
                    key={`${axis.id}:${selected}:${unavailableMapDate?.getTime() ?? ""}`}
                    axisId={axis.id}
                    label={axis.label}
                    value={showsUnavailableAnalysisDate && unavailableMapDate
                      ? unavailableMapDate.toISOString().slice(0, 16)
                      : axisDateInputValue(dataset, axis, selected)}
                    min={axisDateInputValue(dataset, axis, 0)}
                    max={axisDateInputValue(dataset, axis, axis.values.length - 1)}
                    onCommit={(nextValue) => {
                      const date = new Date(`${nextValue}Z`);
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
          {forecastValidDate ? (
            <div className="forecast-valid-time">
              <span>Valid time</span>
              <time dateTime={forecastValidDate.toISOString()}>
                {formatUtcTime(forecastValidDate)}
              </time>
            </div>
          ) : null}
        </div>

        <div className="legend" ref={legendRef} aria-label={`${variable?.label ?? "Variable"} legend`}>
          <div className="legend-controls">
            <label className="legend-unit-control">
              <span>Units</span>
              {availableUnitOptions.length > 1 && selectedUnit ? (
                <select
                  className="unit-select"
                  aria-label="Display unit"
                  title="Display units"
                  value={selectedUnit.id}
                  onChange={(event) => changeDisplayUnit(event.target.value)}
                >
                  {availableUnitOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <strong>{displayUnitLabel || "—"}</strong>
              )}
            </label>
            <div className="opacity-stepper">
              <span>Opacity</span>
              <button
                type="button"
                disabled={opacity <= 0.2}
                aria-label="Decrease opacity"
                title="Decrease opacity"
                onClick={() => changeOpacity(opacity - 0.05)}
              >
                −
              </button>
              <strong>{Math.round(opacity * 100)}%</strong>
              <button
                type="button"
                disabled={opacity >= 1}
                aria-label="Increase opacity"
                title="Increase opacity"
                onClick={() => changeOpacity(opacity + 0.05)}
              >
                +
              </button>
            </div>
          </div>
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
              <button className="legend-limit" type="button" onClick={() => beginLimitEdit("min")}>{formatRangeValue(legendMin, [legendMin, legendMax])} {displayUnitLabel}</button>
            )}
            <span>{formatRangeValue(legendMid, [legendMin, legendMax])}</span>
            {editingLimit === "max" ? (
              <input className="legend-limit-input" aria-label="Maximum color limit" autoFocus type="number" step="any" value={limitDraft} onChange={(event) => setLimitDraft(event.target.value)} onBlur={commitLimitEdit} onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") setEditingLimit(null);
              }} />
            ) : (
              <button className="legend-limit" type="button" onClick={() => beginLimitEdit("max")}>{formatRangeValue(legendMax, [legendMin, legendMax])} {displayUnitLabel}</button>
            )}
          </div>
        </div>

        {loadState.phase === "error" ? <p className="load-error">{loadState.message}</p> : null}
      </section>

      {inspector && info && variable ? (
        <aside
          className={`inspector ${viewMode === "meteogram" ? "meteogram-view" : ""}`}
          data-testid="inspector"
          aria-live="polite"
        >
          <button className="inspector-close" type="button" onClick={clearInspection} aria-label="Close inspection">×</button>
          <div className="inspector-mode" aria-label="Point forecast view">
            <button
              className={viewMode === "series" ? "active" : ""}
              type="button"
              aria-pressed={viewMode === "series"}
              onClick={() => {
                setViewMode("series");
                setMobileScreen("forecast");
              }}
            >
              Time series
            </button>
            <button
              className={viewMode === "meteogram" ? "active" : ""}
              type="button"
              aria-pressed={viewMode === "meteogram"}
              onClick={() => {
                setViewMode("meteogram");
                setMobileScreen("forecast");
              }}
            >
              Meteogram
            </button>
          </div>
          {viewMode === "meteogram" ? (
            <Meteogram
              entries={meteogramEntries}
              fields={meteogramFields}
              phase={meteogramPhase}
              message={meteogramMessage}
              locationLabel={inspectionLocationLabel}
              cursorDate={selectedMapValidDate}
              temperatureUnit={meteogramTemperatureUnit}
              precipitationUnit={meteogramPrecipitationUnit}
              mapPrecipitationRate={
                currentUnitKind === "precipitation_rate"
                && inspector.value !== null
                && inspector.valueTimestamp !== undefined
                  ? {
                    timestamp: inspector.valueTimestamp,
                    value: inspector.value,
                    unit: activeVariableUnit,
                  }
                  : undefined
              }
              windSpeedUnit={meteogramWindSpeedUnit}
              timeZone={inspectionTimeZone}
            />
          ) : (
            <>
          <div className="series-point-summary">
            <strong>
              {formattedInspectorDisplayValue}
              {" "}
              <small>{displayUnitLabel}</small>
            </strong>
            <span>
              {shortCoordinate(inspector.lat, "N", "S")} ·{" "}
              {shortCoordinate(inspector.lng, "E", "W")}
            </span>
            <i aria-hidden="true">·</i>
            <span>{variable.label}</span>
            <i aria-hidden="true">·</i>
            <span className="inspector-axes">
              {axisSummary(info, variable, selections)}
            </span>
          </div>
          {asosStation ? (
            <section className="station-observation" aria-label={`${asosStation.station} station observation`}>
              <header>
                <span>
                  <strong>{asosStation.station}</strong>
                  <small>{asosStation.name}</small>
                </span>
                <em>
                  {[asosStation.state, asosStation.country].filter(Boolean).join(", ")}
                  {Number.isFinite(asosStation.elevation)
                    ? ` · ${asosStation.elevation.toFixed(0)} m`
                    : ""}
                </em>
              </header>
              {currentAsos.record ? (
                <>
                  <div className="station-match">
                    <span>
                      Nearest report · {formatAsosTime(currentAsos.record.valid)}
                    </span>
                    {asosDisplayValue === null ? null : (
                      <strong>
                        {formatOptionalValue(
                          asosDisplayValue,
                          asosDisplayUnit,
                          legendDecimals,
                        )}
                        {gridStationBias === null ? null : (
                          <small>
                            Grid − station {gridStationBias >= 0 ? "+" : ""}
                            {gridStationBias.toFixed(legendDecimals)} {asosDisplayUnit}
                          </small>
                        )}
                      </strong>
                    )}
                  </div>
                  <dl>
                    <div>
                      <dt>Temperature</dt>
                      <dd>{formatOptionalValue(currentAsos.record.tmpc, "°C")}</dd>
                    </div>
                    <div>
                      <dt>Dew point</dt>
                      <dd>{formatOptionalValue(currentAsos.record.dwpc, "°C")}</dd>
                    </div>
                    <div>
                      <dt>Wind</dt>
                      <dd>
                        {currentAsos.record.sknt === null
                          ? "—"
                          : `${currentAsos.record.sknt.toFixed(0)} kt`
                            + (currentAsos.record.drct === null
                              ? ""
                              : ` · ${currentAsos.record.drct.toFixed(0)}°`)}
                      </dd>
                    </div>
                    <div>
                      <dt>MSLP</dt>
                      <dd>{formatOptionalValue(currentAsos.record.mslp, "hPa")}</dd>
                    </div>
                  </dl>
                </>
              ) : (
                <small className="station-no-match">
                  {asosWindow
                    ? "No station report within 90 minutes of the map time."
                    : "Loading observations…"}
                </small>
              )}
            </section>
          ) : null}
          <SeriesComparison
            entries={seriesEntries}
            availableDatasets={TIME_SERIES_DATASETS}
            cursorDate={selectedMapValidDate}
            pickerId={seriesPickerId}
            onPickerChange={setSeriesPickerId}
            onAdd={addComparisonDataset}
            onRemove={removeComparisonDataset}
            displayUnit={selectedUnit}
            timeZone={inspectionTimeZone}
          />
            </>
          )}
        </aside>
      ) : null}
      </div>

      <section className="mobile-map-context" aria-label="Map forecast context">
        <div className="mobile-map-summary">
          <span>
            <strong>
              {inspectionLocationLabel || dataset.label}
            </strong>
            <small>
              {mobileMapValueLabel ? <b>{mobileMapValueLabel}</b> : null}
              {mobileMapValueLabel && variable?.label ? <i>·</i> : null}
              <span>{variable?.label ?? "Choose a map layer"}</span>
            </small>
          </span>
          <button
            type="button"
            onClick={() => setMobileControlsCollapsed(false)}
          >
            Layers
          </button>
        </div>
        {mobileMapAxis ? (
          <div className="mobile-time-controls" aria-label="Map time controls">
            <div className="mobile-axis-control">
              <div className="mobile-axis-heading">
                <span>{mobileMapAxis.label}</span>
                <strong>
                  {formatAxisValue(
                    dataset,
                    mobileMapAxis,
                    mobileMapAxisSelected,
                  )}
                </strong>
              </div>
              <div className="mobile-axis-inputs">
                <button
                  type="button"
                  disabled={mobileMapAxisSelected <= 0}
                  onClick={() =>
                    changeAxis(mobileMapAxis, mobileMapAxisSelected - 1)}
                  aria-label={`Previous ${mobileMapAxis.label}`}
                >
                  ←
                </button>
                <input
                  aria-label={`Compact ${mobileMapAxis.label}`}
                  type="range"
                  min="0"
                  max={Math.max(0, mobileMapAxis.values.length - 1)}
                  step="1"
                  value={mobileMapAxisSelected}
                  onChange={(event) =>
                    changeAxis(mobileMapAxis, Number(event.target.value))}
                />
                <button
                  type="button"
                  disabled={
                    mobileMapAxisSelected >= mobileMapAxis.values.length - 1
                  }
                  onClick={() =>
                    changeAxis(mobileMapAxis, mobileMapAxisSelected + 1)}
                  aria-label={`Next ${mobileMapAxis.label}`}
                >
                  →
                </button>
                <button
                  className="play-button"
                  type="button"
                  disabled={
                    mobileMapAxisSelected >= mobileMapAxis.values.length - 1
                  }
                  onClick={() => togglePlayback(mobileMapAxis)}
                  aria-label={playingAxis === mobileMapAxis.id
                    ? `Pause ${mobileMapAxis.label}`
                    : `Play ${mobileMapAxis.label}`}
                >
                  {playingAxis === mobileMapAxis.id ? "Ⅱ" : "▶"}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </section>

      <nav className="mobile-view-switch" aria-label="Mobile view">
        <button
          className={mobileScreen === "map" ? "active" : ""}
          type="button"
          aria-pressed={mobileScreen === "map"}
          aria-label="Show map"
          onClick={showMobileMap}
        >
          Map
        </button>
        <button
          className={mobileScreen === "forecast" ? "active" : ""}
          type="button"
          aria-pressed={mobileScreen === "forecast"}
          aria-label={inspector
            ? "Show local forecast"
            : "Choose a station for a local forecast"}
          onClick={showMobileForecast}
        >
          Local
        </button>
      </nav>
    </main>
  );
}
