import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  COLORMAPS,
  DEFAULT_COLORMAP,
  defaultColormap,
} from "./colormaps";
import {
  DATA_SOURCE,
  DEFAULT_LEVEL_INDEX,
  DEFAULT_VARIABLE_ID,
  FALLBACK_VARIABLE,
  LAYER_OPTIONS,
  LEVELS,
  PRELOAD_COORDINATES,
  RANGE_SAMPLE_COORDINATES,
  dateToIndex,
  indexToInputDate,
  loadStoreInfo,
  selectorFor,
  toDataCoordinates,
  transformRequest,
  type VariableConfig,
} from "./dataset";

type Projection = "globe" | "mercator";
type Inspector = { lng: number; lat: number; value: number } | null;
type TimeRange = { min: number; max: number };
type FrameSource = "manual" | "playback";
type Limit = "min" | "max";
type LoadState = { phase: "loading" | "ready" | "error"; message: string };

const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const ZARR_LAYER_ID = "zarr-data";
const PLAYBACK_INTERVAL_MS = 100;
const FORWARD_PRELOAD_DEPTH = 10;
const BACKWARD_PRELOAD_DEPTH = 2;
const MULTI_LEVEL_PRELOAD_DEPTH = 1;
const MAX_PRELOAD_RECORDS = 16;
const DEFAULT_CENTER: [number, number] = [-98, 38.5];
const DEFAULT_ZOOM = 1.75;
const READY_STATE: LoadState = { phase: "ready", message: "Ready" };

function loadingState(message = "Loading…"): LoadState {
  return { phase: "loading", message };
}

function errorState(error: unknown): LoadState {
  return { phase: "error", message: error instanceof Error ? error.message : String(error) };
}

function shortCoordinate(value: number, positive: string, negative: string) {
  return `${Math.abs(value).toFixed(2)}°${value >= 0 ? positive : negative}`;
}

function firstFinite(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
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

function robustRange(values: number[]): [number, number] | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const low = sorted[Math.floor((sorted.length - 1) * 0.04)];
  const high = sorted[Math.ceil((sorted.length - 1) * 0.96)];
  if (low === high) {
    const padding = Math.abs(low) * 0.05 || 1;
    return [low - padding, high + padding];
  }
  const padding = (high - low) * 0.04;
  return [low - padding, high + padding];
}

export function ZarrViewer() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("maplibre-gl").Map | null>(null);
  const layerRef = useRef<import("@carbonplan/zarr-layer").ZarrLayer | null>(null);
  const variableRef = useRef<VariableConfig>(FALLBACK_VARIABLE);
  const levelIndexRef = useRef(DEFAULT_LEVEL_INDEX);
  const frameIndexRef = useRef(0);
  const requestGeneration = useRef(0);
  const rangeGeneration = useRef(0);
  const needsRangeEstimateRef = useRef(true);
  const opacityRef = useRef(1);
  const preloadPromisesRef = useRef(new Map<string, Promise<void>>());
  const preparedFramesRef = useRef(new Set<string>());
  const legendRef = useRef<HTMLDivElement>(null);

  const [variables, setVariables] = useState<VariableConfig[]>([FALLBACK_VARIABLE]);
  const [levelAxis, setLevelAxis] = useState({ label: "level", unit: "" });
  const [variable, setVariable] = useState<VariableConfig>(FALLBACK_VARIABLE);
  const [levelIndex, setLevelIndex] = useState(DEFAULT_LEVEL_INDEX);
  const [frameIndex, setFrameIndex] = useState(0);
  const [range, setRange] = useState<TimeRange | null>(null);
  const [opacity, setOpacity] = useState(1);
  const [activeDisplayRange, setActiveDisplayRange] = useState<[number, number]>([0, 1]);
  const [colormapId, setColormapId] = useState(DEFAULT_COLORMAP.id);
  const [colormapOpen, setColormapOpen] = useState(false);
  const [editingLimit, setEditingLimit] = useState<Limit | null>(null);
  const [limitDraft, setLimitDraft] = useState("");
  const [playing, setPlaying] = useState(false);
  const [projection, setProjection] = useState<Projection>("globe");
  const [loadState, setLoadState] = useState<LoadState>(() => loadingState());
  const [mapReady, setMapReady] = useState(false);
  const [inspector, setInspector] = useState<Inspector>(null);

  const level = LEVELS[levelIndex];
  const colormap = useMemo(
    () => COLORMAPS.find((option) => option.id === colormapId) ?? DEFAULT_COLORMAP,
    [colormapId],
  );
  const legendGradient = useMemo(() => `linear-gradient(90deg, ${colormap.colors.join(", ")})`, [colormap]);
  const singleLevelVariables = useMemo(() => variables.filter((candidate) => !candidate.hasLevel), [variables]);
  const multiLevelVariables = useMemo(() => variables.filter((candidate) => candidate.hasLevel), [variables]);

  const applySelector = useCallback(async (nextIndex: number, nextVariable = variableRef.current, nextLevelIndex = levelIndexRef.current) => {
    const layer = layerRef.current;
    if (!layer) return;
    const generation = ++requestGeneration.current;
    setLoadState(loadingState());
    try {
      await layer.setSelector(selectorFor(nextIndex, nextVariable, nextLevelIndex));
      if (generation === requestGeneration.current) {
        setInspector(null);
        setLoadState(READY_STATE);
      }
    } catch (error) {
      if (generation !== requestGeneration.current) return;
      setLoadState(errorState(error));
    }
  }, []);

  const preloadFrame = useCallback((index: number, nextVariable: VariableConfig, nextLevelIndex: number) => {
    const layer = layerRef.current;
    if (!layer) return Promise.resolve();
    const key = `${nextVariable.id}:${nextLevelIndex}:${index}`;
    if (preparedFramesRef.current.has(key)) return Promise.resolve();
    const pending = preloadPromisesRef.current.get(key);
    if (pending) return pending;

    const promise = (async () => {
      await layer.queryData(
        { type: "Point", coordinates: PRELOAD_COORDINATES },
        selectorFor(index, nextVariable, nextLevelIndex),
        { includeSpatialCoordinates: false },
      );
      preparedFramesRef.current.add(key);
      if (preparedFramesRef.current.size > MAX_PRELOAD_RECORDS) {
        const oldest = preparedFramesRef.current.values().next().value;
        if (oldest) preparedFramesRef.current.delete(oldest);
      }
    })()
      .catch((error) => console.debug("Frame preload skipped", error))
      .finally(() => preloadPromisesRef.current.delete(key));

    preloadPromisesRef.current.set(key, promise);
    return promise;
  }, []);

  const selectFrame = useCallback((nextIndex: number, source: FrameSource = "manual") => {
    if (source === "manual") setPlaying(false);
    const clamped = range ? Math.max(range.min, Math.min(range.max, nextIndex)) : nextIndex;
    if (source === "playback" && range && clamped >= range.max) setPlaying(false);
    frameIndexRef.current = clamped;
    setFrameIndex(clamped);
    return applySelector(clamped);
  }, [applySelector, range]);

  const estimateColorRange = useCallback(async () => {
    const layer = layerRef.current;
    if (!layer) return;
    const generation = ++rangeGeneration.current;
    const currentVariable = variableRef.current;
    const currentLevelIndex = levelIndexRef.current;
    const currentSelector = selectorFor(frameIndexRef.current, currentVariable, currentLevelIndex);
    try {
      const results = await Promise.all(RANGE_SAMPLE_COORDINATES.map((coordinates) =>
        layer.queryData({ type: "Point", coordinates }, currentSelector, { includeSpatialCoordinates: false }),
      ));
      if (
        generation !== rangeGeneration.current
        || variableRef.current.id !== currentVariable.id
        || levelIndexRef.current !== currentLevelIndex
      ) return;
      const rangeFromData = robustRange(results.flatMap((result) => {
        const value = firstFinite(result[currentVariable.id]);
        return value === undefined ? [] : [value];
      }));
      if (!rangeFromData) return;
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
    let cancelled = false;
    void loadStoreInfo()
      .then((storeInfo) => {
        if (cancelled) return;
        const initialVariable = storeInfo.variables.find((candidate) => candidate.id === DEFAULT_VARIABLE_ID) ?? storeInfo.variables[0];
        const initialColormap = defaultColormap(initialVariable);
        const initial = Math.max(storeInfo.minTime, storeInfo.maxTime - 11);
        variableRef.current = initialVariable;
        frameIndexRef.current = initial;
        setVariables(storeInfo.variables);
        setLevelAxis(storeInfo.levelAxis);
        setVariable(initialVariable);
        setColormapId(initialColormap.id);
        setRange({ min: storeInfo.minTime, max: storeInfo.maxTime });
        setFrameIndex(initial);
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadState(errorState(error));
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!range || !mapContainerRef.current || mapRef.current) return;
    let disposed = false;
    const initialize = async () => {
      const [{ default: maplibregl }, { ZarrLayer }] = await Promise.all([
        import("maplibre-gl"),
        import("@carbonplan/zarr-layer"),
      ]);
      if (disposed || !mapContainerRef.current) return;

      const map = new maplibregl.Map({
        container: mapContainerRef.current,
        style: MAP_STYLE,
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        minZoom: 0.25,
        maxZoom: 7,
        attributionControl: false,
      });
      mapRef.current = map;
      map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), "bottom-right");
      map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

      map.on("load", () => {
        if (disposed) return;
        map.getContainer().querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
        map.setProjection({ type: "globe" });
        const layerZoomRange = (id: string, minzoom: number, maxzoom = 24) => {
          if (map.getLayer(id)) map.setLayerZoomRange(id, minzoom, maxzoom);
        };
        layerZoomRange("boundary_3", 3);
        layerZoomRange("label_city_capital", 4);
        layerZoomRange("label_city", 5);
        layerZoomRange("label_town", 8);
        layerZoomRange("label_village", 11);
        const firstSymbol = map.getStyle().layers?.find((candidate) => candidate.type === "symbol")?.id;
        const initialVariable = variableRef.current;
        const initialColormap = defaultColormap(initialVariable);
        const zarrLayer = new ZarrLayer({
          id: ZARR_LAYER_ID,
          source: DATA_SOURCE,
          variable: initialVariable.id,
          selector: selectorFor(frameIndexRef.current, initialVariable, levelIndexRef.current),
          colormap: [...initialColormap.colors],
          clim: [0, 1],
          opacity: opacityRef.current,
          ...LAYER_OPTIONS,
          transformRequest,
          onLoadingStateChange: (loading) => {
            if (loading.error) {
              setLoadState(errorState(loading.error));
            } else if (loading.metadata || loading.chunks) {
              setLoadState(loadingState());
            } else {
              setLoadState(READY_STATE);
            }
          },
        });
        layerRef.current = zarrLayer;
        map.addLayer(zarrLayer as unknown as import("maplibre-gl").CustomLayerInterface, firstSymbol);
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

      map.on("click", async (event) => {
        const layer = layerRef.current;
        if (!layer) return;
        setLoadState(loadingState("Reading value…"));
        try {
          const coordinates = toDataCoordinates(event.lngLat.lng, event.lngLat.lat);
          const result = await layer.queryData({ type: "Point", coordinates });
          const values = result[variableRef.current.id];
          const raw = firstFinite(values);
          if (raw === undefined) throw new Error("No data at this location");
          setInspector({ lng: event.lngLat.lng, lat: event.lngLat.lat, value: raw });
          setLoadState(READY_STATE);
        } catch (error) {
          setLoadState(errorState(error));
        }
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
      mapRef.current?.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, [range]);

  useEffect(() => {
    if (!mapReady || loadState.phase !== "ready" || !needsRangeEstimateRef.current) return;
    needsRangeEstimateRef.current = false;
    void estimateColorRange();
  }, [estimateColorRange, levelIndex, loadState.phase, mapReady, variable]);

  useEffect(() => {
    if (!playing || !range || loadState.phase !== "ready") return;
    if (frameIndex >= range.max) return;
    let cancelled = false;
    const nextIndex = frameIndex + 1;
    const prepared = preloadFrame(nextIndex, variable, levelIndex);
    const timeout = window.setTimeout(() => {
      void prepared.then(() => {
        if (!cancelled) void selectFrame(nextIndex, "playback");
      });
    }, PLAYBACK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [frameIndex, levelIndex, loadState.phase, playing, preloadFrame, range, selectFrame, variable]);

  useEffect(() => {
    if (!mapReady || !range || loadState.phase !== "ready") return;
    let cancelled = false;
    void (async () => {
      const forwardDepth = variable.hasLevel ? MULTI_LEVEL_PRELOAD_DEPTH : FORWARD_PRELOAD_DEPTH;
      const forwardOffsets = Array.from({ length: forwardDepth }, (_, index) => index + 1);
      await Promise.all(forwardOffsets.map((offset) => {
        const index = frameIndex + offset;
        return index <= range.max ? preloadFrame(index, variable, levelIndex) : Promise.resolve();
      }));

      if (playing || cancelled || frameIndexRef.current !== frameIndex) return;
      const backwardDepth = variable.hasLevel ? MULTI_LEVEL_PRELOAD_DEPTH : BACKWARD_PRELOAD_DEPTH;
      const backwardOffsets = Array.from({ length: backwardDepth }, (_, index) => -(index + 1));
      await Promise.all(backwardOffsets.map((offset) => {
        const index = frameIndex + offset;
        return index >= range.min ? preloadFrame(index, variable, levelIndex) : Promise.resolve();
      }));
    })();
    return () => {
      cancelled = true;
    };
  }, [frameIndex, levelIndex, loadState.phase, mapReady, playing, preloadFrame, range, variable]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if (event.key === "ArrowLeft") selectFrame(frameIndexRef.current - 1);
      if (event.key === "ArrowRight") selectFrame(frameIndexRef.current + 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectFrame]);

  const changeVariable = async (id: string) => {
    const nextVariable = variables.find((candidate) => candidate.id === id);
    const layer = layerRef.current;
    if (!nextVariable || !layer) return;
    const nextColormap = defaultColormap(nextVariable);
    variableRef.current = nextVariable;
    setVariable(nextVariable);
    setPlaying(false);
    needsRangeEstimateRef.current = true;
    setActiveDisplayRange([0, 1]);
    setEditingLimit(null);
    setColormapOpen(false);
    setColormapId(nextColormap.id);
    const nextLevelIndex = nextVariable.hasLevel
      ? DEFAULT_LEVEL_INDEX
      : levelIndexRef.current;
    levelIndexRef.current = nextLevelIndex;
    setLevelIndex(nextLevelIndex);
    setInspector(null);
    setLoadState(loadingState());
    try {
      layer.setClim([0, 1]);
      layer.setColormap([...nextColormap.colors]);
      await layer.setVariable(nextVariable.id);
      await applySelector(frameIndexRef.current, nextVariable, nextLevelIndex);
    } catch (error) {
      setLoadState(errorState(error));
    }
  };

  const changeLevel = (nextLevelIndex: number) => {
    setPlaying(false);
    needsRangeEstimateRef.current = true;
    setActiveDisplayRange([0, 1]);
    layerRef.current?.setClim([0, 1]);
    levelIndexRef.current = nextLevelIndex;
    setLevelIndex(nextLevelIndex);
    setInspector(null);
    void applySelector(frameIndexRef.current, variableRef.current, nextLevelIndex);
  };

  const changeProjection = (next: Projection) => {
    setProjection(next);
    mapRef.current?.setProjection({ type: next });
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
        setActiveDisplayRange(updated);
        layerRef.current?.setClim(updated);
      }
    }
    setEditingLimit(null);
  };

  const resetView = () => {
    mapRef.current?.flyTo({ center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM, pitch: 0, bearing: 0, duration: 900 });
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
        <button className="reset-button" onClick={resetView} type="button">Reset</button>
      </div>

      <section className="control-panel" aria-label="Viewer controls">
        <div className={`status-indicator ${loadState.phase}`} role="status" title={loadState.phase === "error" ? loadState.message : undefined}>
          <span className="status-spinner" aria-hidden="true" />
          <span className="sr-only">{loadState.message}</span>
        </div>

        <div className="field-grid">
          <label className="field">
            <span>Variable</span>
            <select data-testid="variable-select" value={variable.id} disabled={!mapReady} onChange={(event) => void changeVariable(event.target.value)}>
              <optgroup label="Single-level">
                {singleLevelVariables.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
              </optgroup>
              <optgroup label="Multi-level">
                {multiLevelVariables.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
              </optgroup>
            </select>
          </label>
          {variable.hasLevel ? (
            <label className="field">
              <span>{levelAxis.label}</span>
              <select data-testid="level-select" value={levelIndex} onChange={(event) => changeLevel(Number(event.target.value))}>
                {LEVELS.map((levelValue, index) => <option key={levelValue} value={index}>{levelValue} {levelAxis.unit}</option>)}
              </select>
            </label>
          ) : null}
          <div className="time-control">
            <button data-testid="previous-hour" type="button" disabled={!range || frameIndex <= range.min} onClick={() => selectFrame(frameIndex - 1)} aria-label="Previous hour">←</button>
            <label className="time-input-wrap">
              <span className="sr-only">UTC time</span>
              <input aria-label="UTC time" data-testid="time-input" type="datetime-local" step="3600" value={frameIndex ? indexToInputDate(frameIndex) : ""} min={range ? indexToInputDate(range.min) : undefined} max={range ? indexToInputDate(range.max) : undefined} disabled={!range || !mapReady} onChange={(event) => {
                const parsed = Date.parse(`${event.target.value}:00Z`);
                if (Number.isFinite(parsed)) selectFrame(dateToIndex(new Date(parsed)));
              }} />
            </label>
            <button className="next-button" data-testid="next-hour" type="button" disabled={!range || frameIndex >= range.max} onClick={() => selectFrame(frameIndex + 1)} aria-label="Next hour">→</button>
            <button className="play-button" data-testid="play-pause" type="button" disabled={!range || !mapReady || frameIndex >= range.max} onClick={() => setPlaying((current) => !current)} aria-label={playing ? "Pause animation" : "Play animation"}>{playing ? "Ⅱ" : "▶"}</button>
          </div>
        </div>

        <div className="legend" ref={legendRef} aria-label={`${variable.label} legend`}>
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
              <input className="legend-limit-input" aria-label="Minimum color limit" data-testid="minimum-limit-input" autoFocus type="number" step="any" value={limitDraft} onChange={(event) => setLimitDraft(event.target.value)} onBlur={commitLimitEdit} onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") setEditingLimit(null);
              }} />
            ) : (
              <button className="legend-limit" data-testid="minimum-limit" type="button" onClick={() => beginLimitEdit("min")}>{legendMin.toFixed(legendDecimals)} {variable.unit}</button>
            )}
            <span>{legendMid.toFixed(legendDecimals)}</span>
            {editingLimit === "max" ? (
              <input className="legend-limit-input" aria-label="Maximum color limit" data-testid="maximum-limit-input" autoFocus type="number" step="any" value={limitDraft} onChange={(event) => setLimitDraft(event.target.value)} onBlur={commitLimitEdit} onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") setEditingLimit(null);
              }} />
            ) : (
              <button className="legend-limit" data-testid="maximum-limit" type="button" onClick={() => beginLimitEdit("max")}>{legendMax.toFixed(legendDecimals)} {variable.unit}</button>
            )}
          </div>
        </div>

      </section>

      {inspector ? (
        <aside className="inspector" data-testid="inspector" aria-live="polite">
          <button type="button" onClick={() => setInspector(null)} aria-label="Close inspection">×</button>
          <strong>{inspector.value.toFixed(legendDecimals)} <small>{variable.unit}</small></strong>
          <span>{shortCoordinate(inspector.lat, "N", "S")} · {shortCoordinate(inspector.lng, "E", "W")}</span>
          <span>{variable.label}{variable.hasLevel ? ` · ${level} ${levelAxis.unit}` : ""}</span>
        </aside>
      ) : null}
    </main>
  );
}
