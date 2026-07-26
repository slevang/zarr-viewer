import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  DATASET_CATEGORY_GROUPS,
  datasetOptionLabel,
  type DatasetConfig,
} from "./catalog";
import type { PointSeries } from "./data/types";
import {
  convertPointSeries,
  type UnitOption,
} from "./units";

export type ComparisonSeriesEntry = {
  datasetId: string;
  phase: "loading" | "ready" | "error";
  message: string;
  series?: PointSeries;
  label?: string;
  color?: string;
  removable?: boolean;
};

type SeriesComparisonProps = {
  entries: ComparisonSeriesEntry[];
  availableDatasets: DatasetConfig[];
  cursorDate?: Date;
  pickerId: string;
  onPickerChange: (datasetId: string) => void;
  onAdd: () => void;
  onRemove: (datasetId: string) => void;
  displayUnit: UnitOption | null;
};

const SERIES_COLORS = [
  "#56b4e9",
  "#e69f00",
  "#009e73",
  "#cc79a7",
  "#f0e442",
  "#d55e00",
  "#7fdbff",
  "#b8e186",
  "#a78bfa",
  "#ff7f9f",
  "#00c2d1",
  "#f4a261",
  "#8ec5ff",
  "#e879f9",
  "#facc15",
  "#34d399",
];

function seriesColor(
  datasetId: string,
  availableDatasets: DatasetConfig[],
) {
  const catalogIndex = availableDatasets.findIndex(
    (dataset) => dataset.id === datasetId,
  );
  if (catalogIndex >= 0) {
    return SERIES_COLORS[catalogIndex % SERIES_COLORS.length];
  }

  const hash = Array.from(datasetId).reduce(
    (value, character) => ((value * 31) + character.charCodeAt(0)) >>> 0,
    0,
  );
  return SERIES_COLORS[hash % SERIES_COLORS.length];
}

function entryColor(
  entry: Pick<ComparisonSeriesEntry, "color" | "datasetId">,
  availableDatasets: DatasetConfig[],
) {
  return entry.color ?? seriesColor(entry.datasetId, availableDatasets);
}

function rgba(hex: string, alpha: number) {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${value >> 16}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

function finiteLimits(series: PointSeries) {
  if (series.kind === "history") {
    const values = series.values.filter(Number.isFinite);
    return values.length
      ? [Math.min(...values), Math.max(...values)] as const
      : null;
  }
  const lows = series.quantiles.map((value) => value.min).filter(Number.isFinite);
  const highs = series.quantiles.map((value) => value.max).filter(Number.isFinite);
  return lows.length && highs.length
    ? [Math.min(...lows), Math.max(...highs)] as const
    : null;
}

function decimalsForSpan(min: number, max: number) {
  const span = Math.abs(max - min);
  if (span >= 1000) return 0;
  if (span >= 10) return 1;
  if (span >= 1) return 2;
  return 3;
}

function formatUtcTick(date: Date, span: number) {
  const month = date.toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  const day = date.getUTCDate();
  if (span <= 3 * 24 * 60 * 60 * 1000) {
    return `${month} ${day} ${String(date.getUTCHours()).padStart(2, "0")}Z`;
  }
  return `${month} ${day}`;
}

function formatUtcRangeDate(date: Date) {
  return `${date.toISOString().slice(0, 16).replace("T", " ")}Z`;
}

function interpolatedValueAtTime(
  dates: Date[],
  values: number[],
  timestamp: number,
) {
  const timestamps = dates.map((date) => date.getTime());
  if (
    !timestamps.length
    || timestamp < timestamps[0]
    || timestamp > timestamps[timestamps.length - 1]
  ) return null;

  const upper = timestamps.findIndex((value) => value >= timestamp);
  if (upper < 0) return null;
  if (timestamps[upper] === timestamp || upper === 0) {
    return Number.isFinite(values[upper]) ? values[upper] : null;
  }
  const lower = upper - 1;
  const lowValue = values[lower];
  const highValue = values[upper];
  if (!Number.isFinite(lowValue) || !Number.isFinite(highValue)) return null;
  const span = timestamps[upper] - timestamps[lower];
  const fraction = span
    ? (timestamp - timestamps[lower]) / span
    : 0;
  return lowValue + (highValue - lowValue) * fraction;
}

function valueAtTime(series: PointSeries, timestamp: number) {
  return interpolatedValueAtTime(
    series.dates,
    series.kind === "history"
      ? series.values
      : series.quantiles.map((value) => value.q50),
    timestamp,
  );
}

function nearestTimestamp(timestamps: number[], target: number) {
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

export function SeriesComparison({
  entries,
  availableDatasets,
  cursorDate,
  pickerId,
  onPickerChange,
  onAdd,
  onRemove,
  displayUnit,
}: SeriesComparisonProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{
    timestamp: number;
    x: number;
    alignRight: boolean;
  } | null>(null);
  const plottedEntries = useMemo(
    () => entries.flatMap((entry) =>
      entry.series
        ? [{
          ...entry,
          series: convertPointSeries(entry.series, displayUnit),
        }]
        : []
    ) as Array<ComparisonSeriesEntry & { series: PointSeries }>,
    [displayUnit, entries],
  );
  const chartBounds = useMemo(() => {
    const dates = plottedEntries.flatMap((entry) =>
      entry.series.dates.map((date) => date.getTime()).filter(Number.isFinite),
    );
    const limits = plottedEntries.flatMap((entry) => finiteLimits(entry.series) ?? []);
    if (!dates.length || !limits.length) return null;
    const min = Math.min(...limits);
    const max = Math.max(...limits);
    const padding = (max - min || Math.abs(min) || 1) * 0.05;
    return {
      start: Math.min(...dates),
      stop: Math.max(...dates),
      min: min - padding,
      max: max + padding,
    };
  }, [plottedEntries]);
  const chartTimestamps = useMemo(
    () => Array.from(new Set(
      plottedEntries.flatMap((entry) =>
        entry.series.dates.map((date) => date.getTime()).filter(Number.isFinite),
      ),
    )).sort((left, right) => left - right),
    [plottedEntries],
  );
  const units = Array.from(new Set(plottedEntries.map((entry) => entry.series.unit)));
  const unitLabel = units.length === 1
    ? units[0] || "unitless"
    : units.length
      ? "mixed units"
      : "";
  const decimals = chartBounds
    ? decimalsForSpan(chartBounds.min, chartBounds.max)
    : 1;
  const cursorTimestamp = cursorDate?.getTime();
  const cursorInRange = Boolean(
    chartBounds
    && Number.isFinite(cursorTimestamp)
    && cursorTimestamp! >= chartBounds.start
    && cursorTimestamp! <= chartBounds.stop,
  );
  const hoverValues = useMemo(() => {
    if (!hover) return [];
    return plottedEntries.flatMap((entry) => {
      const value = valueAtTime(entry.series, hover.timestamp);
      if (value === null) return [];
      const ranges = entry.series.kind === "forecast"
        && entry.series.memberCount > 1
        ? {
          q10: interpolatedValueAtTime(
            entry.series.dates,
            entry.series.quantiles.map((item) => item.q10),
            hover.timestamp,
          ),
          q25: interpolatedValueAtTime(
            entry.series.dates,
            entry.series.quantiles.map((item) => item.q25),
            hover.timestamp,
          ),
          q75: interpolatedValueAtTime(
            entry.series.dates,
            entry.series.quantiles.map((item) => item.q75),
            hover.timestamp,
          ),
          q90: interpolatedValueAtTime(
            entry.series.dates,
            entry.series.quantiles.map((item) => item.q90),
            hover.timestamp,
          ),
        }
        : null;
      const dataset = availableDatasets.find(
        (candidate) => candidate.id === entry.datasetId,
      );
      return [{
        datasetId: entry.datasetId,
        label: entry.label ?? dataset?.label ?? entry.datasetId,
        color: entryColor(entry, availableDatasets),
        unit: entry.series.unit,
        value,
        ranges,
      }];
    });
  }, [availableDatasets, hover, plottedEntries]);

  const updateHover = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!chartBounds) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const chartWidth = Math.max(320, rect.width);
    const logicalX = (event.clientX - rect.left) * (chartWidth / rect.width);
    const logicalY = (event.clientY - rect.top) * (204 / rect.height);
    const plotLeft = 56;
    const plotRight = chartWidth - 8;
    const plotTop = 24;
    const plotBottom = 204 - 28;
    if (
      logicalX < plotLeft
      || logicalX > plotRight
      || logicalY < plotTop
      || logicalY > plotBottom
    ) {
      setHover(null);
      return;
    }
    const fraction = (logicalX - plotLeft) / Math.max(1, plotRight - plotLeft);
    const timestamp = nearestTimestamp(
      chartTimestamps,
      chartBounds.start + fraction * (chartBounds.stop - chartBounds.start),
    );
    const snappedFraction = (timestamp - chartBounds.start)
      / Math.max(1, chartBounds.stop - chartBounds.start);
    const visibleX = (
      plotLeft + snappedFraction * (plotRight - plotLeft)
    ) * (rect.width / chartWidth);
    setHover({
      timestamp,
      x: visibleX,
      alignRight: visibleX > rect.width / 2,
    });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !chartBounds) return;
    const width = Math.max(320, canvas.clientWidth);
    const height = 204;
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(scale, scale);
    context.clearRect(0, 0, width, height);

    const plot = { left: 56, right: width - 8, top: 24, bottom: height - 28 };
    const xSpan = chartBounds.stop - chartBounds.start || 1;
    const ySpan = chartBounds.max - chartBounds.min || 1;
    const point = (date: Date, value: number): [number, number] => [
      plot.left + ((date.getTime() - chartBounds.start) / xSpan) * (plot.right - plot.left),
      plot.bottom - ((value - chartBounds.min) / ySpan) * (plot.bottom - plot.top),
    ];

    context.font = '10px "Geist Variable", ui-sans-serif, system-ui, sans-serif';
    context.fillStyle = "rgba(219,232,255,0.7)";
    context.textBaseline = "middle";
    context.textAlign = "left";
    context.fillText(unitLabel, 5, 10);

    context.lineWidth = 1;
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      const y = plot.bottom - fraction * (plot.bottom - plot.top);
      const value = chartBounds.min + fraction * ySpan;
      context.fillStyle = "rgba(219,232,255,0.72)";
      context.textAlign = "right";
      context.fillText(value.toFixed(decimals), plot.left - 7, y);
      context.strokeStyle = fraction === 0 || fraction === 1
        ? "rgba(255,255,255,0.16)"
        : "rgba(255,255,255,0.09)";
      context.beginPath();
      context.moveTo(plot.left, y);
      context.lineTo(plot.right, y);
      context.stroke();
    }
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      const timestamp = chartBounds.start + fraction * xSpan;
      const x = plot.left + fraction * (plot.right - plot.left);
      context.strokeStyle = "rgba(255,255,255,0.12)";
      context.beginPath();
      context.moveTo(x, plot.bottom);
      context.lineTo(x, plot.bottom + 4);
      context.stroke();
      context.fillStyle = "rgba(219,232,255,0.72)";
      context.textAlign = fraction === 0 ? "left" : fraction === 1 ? "right" : "center";
      context.textBaseline = "top";
      context.fillText(
        formatUtcTick(new Date(timestamp), xSpan),
        x,
        plot.bottom + 7,
      );
    }

    context.save();
    context.beginPath();
    context.rect(
      plot.left,
      plot.top,
      plot.right - plot.left,
      plot.bottom - plot.top,
    );
    context.clip();

    const drawLine = (
      dates: Date[],
      values: number[],
      color: string,
      widthValue = 1.4,
    ) => {
      context.beginPath();
      let started = false;
      values.forEach((value, index) => {
        const date = dates[index];
        if (!date || !Number.isFinite(value)) {
          started = false;
          return;
        }
        const [x, y] = point(date, value);
        if (started) context.lineTo(x, y);
        else context.moveTo(x, y);
        started = true;
      });
      context.strokeStyle = color;
      context.lineWidth = widthValue;
      context.stroke();
    };

    const drawBand = (
      entry: ComparisonSeriesEntry & { series: PointSeries },
      lower: "q10" | "q25",
      upper: "q75" | "q90",
      alpha: number,
    ) => {
      if (entry.series.kind !== "forecast") return;
      const valid = entry.series.quantiles.flatMap((quantiles, index) => {
        const low = quantiles[lower];
        const high = quantiles[upper];
        const date = entry.series.dates[index];
        return date && Number.isFinite(low) && Number.isFinite(high)
          ? [{ date, low, high }]
          : [];
      });
      if (!valid.length) return;
      context.beginPath();
      valid.forEach(({ date, high }, index) => {
        const [x, y] = point(date, high);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      for (let index = valid.length - 1; index >= 0; index -= 1) {
        const [x, y] = point(valid[index].date, valid[index].low);
        context.lineTo(x, y);
      }
      context.closePath();
      context.fillStyle = rgba(
        entryColor(entry, availableDatasets),
        alpha,
      );
      context.fill();
    };

    plottedEntries.forEach((entry) => {
      if (entry.series.kind === "forecast" && entry.series.memberCount > 1) {
        drawBand(entry, "q10", "q90", 0.12);
        drawBand(entry, "q25", "q75", 0.22);
      }
    });
    plottedEntries.forEach((entry) => {
      const color = entryColor(entry, availableDatasets);
      if (entry.series.kind === "history") {
        drawLine(entry.series.dates, entry.series.values, color);
      } else {
        drawLine(
          entry.series.dates,
          entry.series.quantiles.map((value) => value.q50),
          color,
          1.6,
        );
      }
    });
    if (cursorInRange && cursorTimestamp !== undefined) {
      const x = plot.left
        + ((cursorTimestamp - chartBounds.start) / xSpan)
        * (plot.right - plot.left);
      context.save();
      context.setLineDash([3, 3]);
      context.strokeStyle = "rgba(255,255,255,0.7)";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x, plot.top);
      context.lineTo(x, plot.bottom);
      context.stroke();
      context.restore();

      plottedEntries.forEach((entry) => {
        const value = valueAtTime(entry.series, cursorTimestamp);
        if (value === null) return;
        const [, y] = point(new Date(cursorTimestamp), value);
        context.beginPath();
        context.arc(x, y, 4, 0, Math.PI * 2);
        context.fillStyle = entryColor(entry, availableDatasets);
        context.fill();
        context.strokeStyle = "rgba(255,255,255,0.95)";
        context.lineWidth = 1.5;
        context.stroke();
      });
    }
    if (hover) {
      const x = plot.left
        + ((hover.timestamp - chartBounds.start) / xSpan)
        * (plot.right - plot.left);
      context.save();
      context.strokeStyle = "rgba(255,255,255,0.55)";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x, plot.top);
      context.lineTo(x, plot.bottom);
      context.stroke();
      context.restore();

      plottedEntries.forEach((entry) => {
        const value = valueAtTime(entry.series, hover.timestamp);
        if (value === null) return;
        const [, y] = point(new Date(hover.timestamp), value);
        context.beginPath();
        context.arc(x, y, 3.5, 0, Math.PI * 2);
        context.fillStyle = entryColor(entry, availableDatasets);
        context.fill();
        context.strokeStyle = "rgba(255,255,255,0.9)";
        context.lineWidth = 1;
        context.stroke();
      });
    }
    context.restore();
  }, [
    availableDatasets,
    chartBounds,
    cursorInRange,
    cursorTimestamp,
    decimals,
    hover,
    plottedEntries,
    unitLabel,
  ]);
  const selectedIds = new Set(entries.map((entry) => entry.datasetId));
  const addableDatasets = availableDatasets.filter(
    (dataset) => !selectedIds.has(dataset.id),
  );

  return (
    <section className="series-comparison" aria-label="Model time-series comparison">
      <div className="series-picker">
        <label>
          <span>Comparison dataset</span>
          <select
            aria-label="Comparison dataset"
            value={pickerId}
            disabled={!addableDatasets.length}
            onChange={(event) => onPickerChange(event.target.value)}
          >
            {DATASET_CATEGORY_GROUPS.map((group) => {
              const datasets = addableDatasets.filter(
                (dataset) => dataset.category === group.id,
              );
              return datasets.length ? (
                <optgroup key={group.id} label={group.label}>
                  {datasets.map((dataset) => (
                    <option key={dataset.id} value={dataset.id}>
                      {datasetOptionLabel(dataset)}
                    </option>
                  ))}
                </optgroup>
              ) : null;
            })}
          </select>
        </label>
        <button
          className="series-add"
          type="button"
          disabled={!addableDatasets.some((dataset) => dataset.id === pickerId)}
          onClick={onAdd}
        >
          Add
        </button>
      </div>

      {chartBounds ? (
        <>
          <div className="series-heading">
            <span>15-day timeseries</span>
            <strong>
              {cursorInRange && cursorDate
                ? `Map ${formatUtcRangeDate(cursorDate)}`
                : "Map time outside range"}
            </strong>
          </div>
          <div className="series-chart">
            <canvas
              ref={canvasRef}
              aria-label={cursorInRange && cursorDate
                ? `Overlaid model time series with map tracer at ${formatUtcRangeDate(cursorDate)}`
                : "Overlaid model time series"}
              onPointerMove={updateHover}
              onPointerLeave={() => setHover(null)}
            />
            {hover && hoverValues.length ? (
              <div
                className={`series-tooltip ${hover.alignRight ? "right" : ""}`}
                style={{ left: hover.x }}
                aria-hidden="true"
              >
                <time>{formatUtcRangeDate(new Date(hover.timestamp))}</time>
                {hoverValues.map((item) => (
                  <div className="series-tooltip-row" key={item.datasetId}>
                    <i style={{ background: item.color }} />
                    <span>
                      <strong>{item.label}</strong>
                      {item.ranges
                        && item.ranges.q10 !== null
                        && item.ranges.q25 !== null
                        && item.ranges.q75 !== null
                        && item.ranges.q90 !== null ? (
                          <small>
                            25–75% {item.ranges.q25.toFixed(decimals)}
                            –{item.ranges.q75.toFixed(decimals)}
                            {" · "}10–90% {item.ranges.q10.toFixed(decimals)}
                            –{item.ranges.q90.toFixed(decimals)}
                          </small>
                        ) : null}
                    </span>
                    <b>
                      {item.value.toFixed(decimals)} {item.unit}
                    </b>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <div className="series-dates">
            <span>{formatUtcRangeDate(new Date(chartBounds.start))}</span>
            <span>{formatUtcRangeDate(new Date(chartBounds.stop))}</span>
          </div>
        </>
      ) : (
        <span className="series-empty">
          Add one or more forecast or historical datasets to compare this point.
        </span>
      )}

      <div className="series-list">
        {entries.map((entry) => {
          const dataset = availableDatasets.find(
            (candidate) => candidate.id === entry.datasetId,
          );
          const detail = entry.phase === "ready" && entry.series
            ? entry.series.kind === "forecast"
              ? entry.series.memberCount > 1
                ? `${entry.series.variableLabel} · ${entry.series.memberCount} members · median + 10–90 / 25–75%`
                : entry.series.variableLabel
              : entry.series.variableLabel
            : entry.message;
          return (
            <div className={`series-list-item ${entry.phase}`} key={entry.datasetId}>
              <i
                style={{
                  background: entryColor(entry, availableDatasets),
                }}
              />
              <span>
                <strong>{entry.label ?? dataset?.label ?? entry.datasetId}</strong>
                <small>{detail}</small>
              </span>
              {entry.removable === false ? null : (
                <button
                  type="button"
                  onClick={() => onRemove(entry.datasetId)}
                  aria-label={`Remove ${
                    entry.label ?? dataset?.label ?? entry.datasetId
                  }`}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
