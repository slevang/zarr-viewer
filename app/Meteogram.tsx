import { useMemo, useState, type PointerEvent } from "react";
import { HorizontalScrollWindow } from "./components/HorizontalScrollWindow";
import type { PointSeries } from "./data/types";
import type { ComparisonSeriesEntry } from "./SeriesComparison";
import {
  convertPointSeries,
  convertUnitValue,
  type UnitOption,
} from "./units";
import {
  meteogramDayTicks,
  meteogramHoverTimestamps,
  nearestTimestamp,
  windArrowRotation,
} from "./viewer/meteogram";
import {
  FORECAST_WINDOW_DAYS,
  timelineRangeDays,
  timelineWidthPercent,
} from "./viewer/timeline";
import {
  formatLocalTimeIndicator,
  formatUtcTimeIndicator,
} from "./viewer/time-zone";

export type MeteogramFields = {
  precipitationRate?: PointSeries;
  precipitationProbability?: PointSeries;
  cloudCover?: PointSeries;
  windSpeed?: PointSeries;
  windSpeedDistribution?: PointSeries;
  windDirection?: PointSeries;
  heatIndex?: PointSeries;
  windChill?: PointSeries;
};

type MeteogramProps = {
  entries: ComparisonSeriesEntry[];
  fields: MeteogramFields;
  phase: "idle" | "loading" | "ready" | "error";
  message: string;
  locationLabel: string;
  cursorDate?: Date;
  temperatureUnit: UnitOption | null;
  precipitationUnit: UnitOption;
  mapPrecipitationRate?: {
    timestamp: number;
    value: number;
    unit: string;
  };
  windSpeedUnit: UnitOption | null;
  timeZone: string;
};

const WIDTH = 860;
const HEIGHT = 268;
const LEFT = 64;
const RIGHT = 848;
const TEMP_TOP = 22;
const TEMP_BOTTOM = 84;
const WEATHER_TOP = 98;
const WEATHER_BOTTOM = 160;
const WIND_TOP = 174;
const WIND_BOTTOM = 236;
const COLORS = ["#ffb454", "#68b9ff", "#f07bbd", "#9cdb87"];

function valuesOf(series: PointSeries) {
  return series.kind === "history"
    ? series.values
    : series.quantiles.map((value) => value.q50);
}

function valueAt(series: PointSeries | undefined, timestamp: number) {
  if (!series?.dates.length) return null;
  let index = 0;
  let distance = Infinity;
  series.dates.forEach((date, candidate) => {
    const next = Math.abs(date.getTime() - timestamp);
    if (next < distance) {
      index = candidate;
      distance = next;
    }
  });
  const value = valuesOf(series)[index];
  return Number.isFinite(value) ? value : null;
}

function bestValueAt(series: PointSeries[], timestamp: number) {
  const covering = series.find((candidate) => {
    const first = candidate.dates[0]?.getTime();
    const last = candidate.dates.at(-1)?.getTime();
    return first !== undefined
      && last !== undefined
      && timestamp >= first
      && timestamp <= last;
  });
  return valueAt(covering ?? series.at(-1), timestamp);
}

function percentValues(series: PointSeries | undefined) {
  if (!series) return [];
  const values = valuesOf(series);
  const scale = Math.max(...values.filter(Number.isFinite), 0) <= 1.5 ? 100 : 1;
  return values.map((value) => value * scale);
}

function shortModelLabel(label: string) {
  return label
    .replace(" forecast", "")
    .replace("ECMWF ", "")
    .replace("NOAA ", "")
    .replace("DWD ", "");
}

function pathFor(
  dates: Date[],
  values: number[],
  x: (timestamp: number) => number,
  y: (value: number) => number,
) {
  let started = false;
  return values.map((value, index) => {
    const date = dates[index];
    if (!date || !Number.isFinite(value)) {
      started = false;
      return "";
    }
    const command = started ? "L" : "M";
    started = true;
    return `${command}${x(date.getTime()).toFixed(1)},${y(value).toFixed(1)}`;
  }).join(" ");
}

function bandPath(
  series: PointSeries,
  x: (timestamp: number) => number,
  y: (value: number) => number,
  lowerKey: "q10" | "q25" = "q10",
  upperKey: "q75" | "q90" = "q90",
) {
  if (series.kind !== "forecast" || series.memberCount < 2) return "";
  const upperPath = series.quantiles.map((item, index) =>
    `${index ? "L" : "M"}${x(series.dates[index].getTime()).toFixed(1)},${y(item[upperKey]).toFixed(1)}`
  ).join(" ");
  const lowerPath = [...series.quantiles].reverse().map((item, reverseIndex) => {
    const index = series.quantiles.length - reverseIndex - 1;
    return `L${x(series.dates[index].getTime()).toFixed(1)},${y(item[lowerKey]).toFixed(1)}`;
  }).join(" ");
  return `${upperPath} ${lowerPath} Z`;
}

export function Meteogram({
  entries,
  fields,
  phase,
  message,
  locationLabel,
  cursorDate,
  temperatureUnit,
  precipitationUnit,
  mapPrecipitationRate,
  windSpeedUnit,
  timeZone,
}: MeteogramProps) {
  const [hoverTimestamp, setHoverTimestamp] = useState<number | null>(null);
  const temperatures = useMemo(
    () => entries.flatMap((entry) => entry.series
      ? [{
        ...entry,
        series: convertPointSeries(entry.series, temperatureUnit),
      }]
      : []),
    [entries, temperatureUnit],
  );
  const timeRange = useMemo(() => {
    const timestamps = [
      ...temperatures.flatMap((entry) => entry.series.dates.map((date) => date.getTime())),
      ...Object.values(fields).flatMap((series) =>
        series?.dates.map((date) => date.getTime()) ?? []
      ),
    ].filter(Number.isFinite);
    return timestamps.length
      ? { start: Math.min(...timestamps), stop: Math.max(...timestamps) }
      : null;
  }, [fields, temperatures]);
  const hoverTimestamps = useMemo(() => {
    const temperatureSeries = temperatures.map((entry) => entry.series);
    const fieldSeries = Object.values(fields).filter(
      (series): series is PointSeries => Boolean(series),
    );
    return meteogramHoverTimestamps(
      temperatureSeries.length ? temperatureSeries : fieldSeries,
    );
  }, [fields, temperatures]);
  const chartRangeDays = timeRange
    ? timelineRangeDays(timeRange.start, timeRange.stop)
    : FORECAST_WINDOW_DAYS;
  const chartWidthPercent = timeRange
    ? timelineWidthPercent(timeRange.start, timeRange.stop)
    : 100;
  const temperatureRange = useMemo(() => {
    const values = temperatures.flatMap((entry) => {
      const series = entry.series;
      if (series.kind === "history") return series.values;
      return series.quantiles.flatMap((item) => [item.q10, item.q90]);
    }).filter(Number.isFinite);
    if (!values.length) return { min: 0, max: 1 };
    const min = Math.floor(Math.min(...values) / 5) * 5;
    const max = Math.ceil(Math.max(...values) / 5) * 5;
    return { min, max: max === min ? min + 5 : max };
  }, [temperatures]);
  const guidanceHandoff = useMemo(() => {
    const regional = temperatures.find(
      (entry) =>
        entry.series.kind === "forecast"
        && entry.series.memberCount <= 1,
    );
    const ensemble = temperatures.find(
      (entry) =>
        entry.series.kind === "forecast"
        && entry.series.memberCount > 1,
    );
    if (!regional || !ensemble) return null;
    const timestamp = regional.series.dates.at(-1)?.getTime();
    const ensembleStop = ensemble.series.dates.at(-1)?.getTime();
    return timestamp !== undefined
      && ensembleStop !== undefined
      && timestamp < ensembleStop
      ? {
        timestamp,
        label: `${shortModelLabel(regional.label ?? regional.datasetId)} → ${
          shortModelLabel(ensemble.label ?? ensemble.datasetId)
        }`,
      }
      : null;
  }, [temperatures]);
  const activeTimestamp = hoverTimestamp
    ?? cursorDate?.getTime()
    ?? timeRange?.start
    ?? 0;
  const x = (timestamp: number) => LEFT + (
    (timestamp - (timeRange?.start ?? 0))
    / Math.max(1, (timeRange?.stop ?? 1) - (timeRange?.start ?? 0))
  ) * (RIGHT - LEFT);
  const yTemperature = (value: number) => TEMP_BOTTOM - (
    (value - temperatureRange.min)
    / Math.max(1, temperatureRange.max - temperatureRange.min)
  ) * (TEMP_BOTTOM - TEMP_TOP);
  const temperatureTicks = [0, 0.5, 1].map((fraction) => {
    const value = temperatureRange.min
      + fraction * (temperatureRange.max - temperatureRange.min);
    return { fraction, value, y: yTemperature(value) };
  });
  const cloud = percentValues(fields.cloudCover);
  const probability = percentValues(fields.precipitationProbability);
  const precipitationSeries = useMemo(
    () => fields.precipitationRate
      ? convertPointSeries(fields.precipitationRate, precipitationUnit)
      : undefined,
    [fields.precipitationRate, precipitationUnit],
  );
  const mapPrecipitationValue = mapPrecipitationRate
    ? convertUnitValue(
      mapPrecipitationRate.value,
      mapPrecipitationRate.unit,
      precipitationUnit.id,
      "Precipitation rate",
    )
    : undefined;
  const precipitation = precipitationSeries
    ? valuesOf(precipitationSeries).map((value, index) =>
      mapPrecipitationRate
        && precipitationSeries.dates[index]?.getTime()
          === mapPrecipitationRate.timestamp
        && mapPrecipitationValue !== undefined
        && Number.isFinite(mapPrecipitationValue)
        ? mapPrecipitationValue
        : value
    )
    : [];
  const minimumPrecipitationMaximum = convertUnitValue(
    0.1,
    "mm/h",
    precipitationUnit.id,
    "Precipitation rate",
  );
  const precipitationMaximum = Math.max(
    ...precipitation.filter(Number.isFinite),
    minimumPrecipitationMaximum,
  );
  const maxPrecipitation = precipitationMaximum <= 1
    ? Math.ceil(precipitationMaximum * 10) / 10
    : precipitationMaximum <= 5
      ? Math.ceil(precipitationMaximum)
      : Math.ceil(precipitationMaximum / 5) * 5;
  const precipitationDecimals = maxPrecipitation < 0.1
    ? 2
    : maxPrecipitation < 1
      ? 1
      : 0;
  const windSpeedSeries = useMemo(
    () => fields.windSpeed
      ? convertPointSeries(fields.windSpeed, windSpeedUnit)
      : undefined,
    [fields.windSpeed, windSpeedUnit],
  );
  const windDistribution = useMemo(
    () => fields.windSpeedDistribution
      ? convertPointSeries(fields.windSpeedDistribution, windSpeedUnit)
      : undefined,
    [fields.windSpeedDistribution, windSpeedUnit],
  );
  const wind = windSpeedSeries ? valuesOf(windSpeedSeries) : [];
  const windHighs = windDistribution?.kind === "forecast"
    ? windDistribution.quantiles.map((item) => item.q90)
    : wind;
  const maxWind = Math.max(
    5,
    Math.ceil(Math.max(...windHighs.filter(Number.isFinite), 0)),
  );
  const windUnit = windSpeedSeries?.unit ?? "m/s";
  const direction = fields.windDirection ? valuesOf(fields.windDirection) : [];
  const dayTicks = timeRange
    ? meteogramDayTicks(timeRange.start, timeRange.stop)
    : [];
  const selectedTemperature = bestValueAt(
    temperatures.map((entry) => entry.series),
    activeTimestamp,
  );
  const heatIndex = valueAt(
    fields.heatIndex
      ? convertPointSeries(fields.heatIndex, temperatureUnit)
      : undefined,
    activeTimestamp,
  );
  const windChill = valueAt(
    fields.windChill
      ? convertPointSeries(fields.windChill, temperatureUnit)
      : undefined,
    activeTimestamp,
  );
  const apparentTemperature = selectedTemperature === null
    ? null
    : [heatIndex, windChill]
      .filter((value): value is number => value !== null)
      .sort((first, second) =>
        Math.abs(second - selectedTemperature) - Math.abs(first - selectedTemperature)
      )[0] ?? selectedTemperature;
  const activeProbability = valueAt(
    fields.precipitationProbability,
    activeTimestamp,
  );
  const activeCloudRaw = valueAt(fields.cloudCover, activeTimestamp);
  const activeCloud = activeCloudRaw === null
    ? null
    : activeCloudRaw <= 1.5 ? activeCloudRaw * 100 : activeCloudRaw;
  const pointSeriesPrecipitation = valueAt(
    precipitationSeries,
    activeTimestamp,
  );
  const activePrecipitation = mapPrecipitationRate
      && activeTimestamp === mapPrecipitationRate.timestamp
      && mapPrecipitationValue !== undefined
      && Number.isFinite(mapPrecipitationValue)
    ? mapPrecipitationValue
    : pointSeriesPrecipitation;
  const activeWind = valueAt(windSpeedSeries, activeTimestamp);
  const activeDirection = valueAt(fields.windDirection, activeTimestamp);
  const updateHover = (event: PointerEvent<SVGSVGElement>) => {
    if (!timeRange) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const logicalX = (event.clientX - bounds.left) * WIDTH / bounds.width;
    if (logicalX < LEFT || logicalX > RIGHT) {
      setHoverTimestamp(null);
      return;
    }
    const pointerTimestamp = timeRange.start
      + (logicalX - LEFT) / (RIGHT - LEFT) * (timeRange.stop - timeRange.start);
    setHoverTimestamp(
      nearestTimestamp(hoverTimestamps, pointerTimestamp),
    );
  };

  return (
    <section className="meteogram" aria-label="Hourly model meteogram">
      <header className="meteogram-header">
        <strong title={locationLabel}>{locationLabel}</strong>
        <div className="meteogram-times">
          <time>{formatUtcTimeIndicator(new Date(activeTimestamp))}</time>
          <i aria-hidden="true">·</i>
          <time title={timeZone}>
            {formatLocalTimeIndicator(new Date(activeTimestamp), timeZone)}
          </time>
        </div>
      </header>

      <div className="meteogram-readout" aria-label="Selected hour weather">
        <span>
          Temp
          <strong>
            {selectedTemperature === null ? "—" : Math.round(selectedTemperature)}
            <small>
              {temperatureUnit?.label ?? temperatures[0]?.series.unit ?? ""}
            </small>
          </strong>
          <small className="meteogram-feels">
            Feels{" "}
            {heatIndex === null && windChill === null
              ? "—"
              : apparentTemperature === null
                ? "—"
                : `${Math.round(apparentTemperature)}°`}
          </small>
        </span>
        <span>
          Rain
          <strong>
            {activeProbability === null ? "—" : `${Math.round(activeProbability)}%`}
          </strong>
          <small>
            {activePrecipitation === null
              ? "—"
              : `${
                activePrecipitation.toFixed(activePrecipitation < 1 ? 2 : 1)
              } ${precipitationUnit.label}`}
          </small>
        </span>
        <span>
          Cloud
          <strong>{activeCloud === null ? "—" : `${Math.round(activeCloud)}%`}</strong>
        </span>
        <span>
          Wind
          <strong>
            {activeWind === null ? "—" : activeWind.toFixed(1)}
            <small> {windUnit}</small>
          </strong>
          <small>
            {activeDirection === null ? "—" : `${Math.round(activeDirection)}°`}
          </small>
        </span>
      </div>

      {timeRange ? (
        <HorizontalScrollWindow
          ariaLabel={`${FORECAST_WINDOW_DAYS}-day meteogram window; scroll horizontally for later forecast dates`}
          className="meteogram-chart"
          contentWidthPercent={chartWidthPercent}
          label={`${FORECAST_WINDOW_DAYS}-day view · ${chartRangeDays}-day range`}
          overlay={(
            <div className="meteogram-fixed-overlay">
              <div
                className="meteogram-legend"
                aria-label="Temperature model legend"
              >
                {entries.map((entry, index) => (
                  <span className={entry.phase} key={entry.datasetId}>
                    <i style={{ background: COLORS[index % COLORS.length] }} />
                    {shortModelLabel(entry.label ?? entry.datasetId)}
                    {entry.phase === "loading" ? " · loading" : ""}
                  </span>
                ))}
              </div>
              <div
                className="meteogram-fixed-axis meteogram-fixed-axis-left"
                aria-hidden="true"
              >
                <span
                  className="meteogram-axis-title"
                  style={{ top: `${(TEMP_TOP + TEMP_BOTTOM) / 2 / HEIGHT * 100}%` }}
                >
                  TEMP
                </span>
                <span
                  className="meteogram-axis-title"
                  style={{ top: `${(WEATHER_TOP + WEATHER_BOTTOM) / 2 / HEIGHT * 100}%` }}
                >
                  PRECIP / CLOUD
                </span>
                <span
                  className="meteogram-axis-title"
                  style={{ top: `${(WIND_TOP + WIND_BOTTOM) / 2 / HEIGHT * 100}%` }}
                >
                  WIND
                </span>
                {temperatureTicks.map(({ fraction, value, y }) => (
                  <span
                    className="meteogram-axis-tick"
                    key={`temperature-${fraction}`}
                    style={{ top: `${y / HEIGHT * 100}%` }}
                  >
                    {value.toFixed(0)}°
                  </span>
                ))}
                <span
                  className="meteogram-axis-tick"
                  style={{ top: `${WEATHER_TOP / HEIGHT * 100}%` }}
                >
                  {maxPrecipitation.toFixed(precipitationDecimals)}{" "}
                  {precipitationUnit.label}
                </span>
                <span
                  className="meteogram-axis-tick"
                  style={{ top: `${WEATHER_BOTTOM / HEIGHT * 100}%` }}
                >
                  0 {precipitationUnit.label}
                </span>
                <span
                  className="meteogram-axis-tick"
                  style={{ top: `${WIND_TOP / HEIGHT * 100}%` }}
                >
                  {maxWind.toFixed(0)} {windUnit}
                </span>
                <span
                  className="meteogram-axis-tick"
                  style={{ top: `${WIND_BOTTOM / HEIGHT * 100}%` }}
                >
                  0 {windUnit}
                </span>
              </div>
            </div>
          )}
          resetKey={`${timeRange.start}:${timeRange.stop}`}
        >
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            role="img"
            aria-label="Temperature, precipitation, cloud cover, wind speed, and wind direction forecast"
            onPointerMove={updateHover}
            onPointerLeave={() => setHoverTimestamp(null)}
          >
            <defs>
              <linearGradient id="meteogram-cloud" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#d8e1e6" stopOpacity=".62" />
                <stop offset="1" stopColor="#7f8e96" stopOpacity=".18" />
              </linearGradient>
              <linearGradient id="meteogram-rain" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#43b9ff" stopOpacity=".95" />
                <stop offset="1" stopColor="#0876ba" stopOpacity=".28" />
              </linearGradient>
              <clipPath id="meteogram-plot">
                <rect x={LEFT} y={TEMP_TOP} width={RIGHT - LEFT} height={WIND_BOTTOM - TEMP_TOP} />
              </clipPath>
            </defs>

            {dayTicks.map(({ timestamp, showLabel }) => (
              <g key={timestamp}>
                <line
                  x1={x(timestamp)}
                  x2={x(timestamp)}
                  y1={TEMP_TOP}
                  y2={WIND_BOTTOM}
                  className="time-grid"
                />
                {showLabel ? (
                  <text x={x(timestamp)} y={HEIGHT - 7} textAnchor="middle">
                    {new Date(timestamp).toLocaleString("en-US", {
                      month: "short",
                      day: "numeric",
                      timeZone: "UTC",
                    })}
                  </text>
                ) : null}
              </g>
            ))}

            {temperatureTicks.map(({ fraction, y }) => (
              <line
                key={fraction}
                x1={LEFT}
                x2={RIGHT}
                y1={y}
                y2={y}
                className="value-grid"
              />
            ))}
            {guidanceHandoff ? (
              <>
                <line
                  x1={x(guidanceHandoff.timestamp)}
                  x2={x(guidanceHandoff.timestamp)}
                  y1={WEATHER_TOP}
                  y2={WIND_BOTTOM}
                  className="guidance-handoff"
                />
                <text
                  x={x(guidanceHandoff.timestamp)}
                  y={WIND_TOP - 7}
                  textAnchor="middle"
                  className="handoff-label"
                >
                  {guidanceHandoff.label}
                </text>
              </>
            ) : null}

            <g clipPath="url(#meteogram-plot)">
              {temperatures.map((entry, index) => entry.series.kind === "forecast" ? (
                <path
                  key={`${entry.datasetId}-band`}
                  d={bandPath(entry.series, x, yTemperature)}
                  fill={COLORS[index % COLORS.length]}
                  fillOpacity=".1"
                />
              ) : null)}
              {temperatures.map((entry, index) => (
                <path
                  key={entry.datasetId}
                  d={pathFor(
                    entry.series.dates,
                    valuesOf(entry.series),
                    x,
                    yTemperature,
                  )}
                  fill="none"
                  stroke={COLORS[index % COLORS.length]}
                  strokeWidth={index === 0 ? 2.4 : 1.8}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ))}

              {fields.cloudCover?.dates.map((date, index) => {
                const next = fields.cloudCover?.dates[index + 1]?.getTime()
                  ?? date.getTime() + 3 * 60 * 60 * 1000;
                const width = Math.max(2, x(next) - x(date.getTime()));
                const value = cloud[index];
                if (!Number.isFinite(value)) return null;
                return (
                  <rect
                    key={`cloud-${date.getTime()}`}
                    x={x(date.getTime())}
                    y={WEATHER_BOTTOM
                      - (WEATHER_BOTTOM - WEATHER_TOP) * value / 100}
                    width={width}
                    height={(WEATHER_BOTTOM - WEATHER_TOP) * value / 100}
                    fill="url(#meteogram-cloud)"
                  />
                );
              })}
              {precipitationSeries?.dates.map((date, index) => {
                const next = precipitationSeries.dates[index + 1]?.getTime()
                  ?? date.getTime() + 3 * 60 * 60 * 1000;
                const width = Math.max(2, x(next) - x(date.getTime()));
                const amount = precipitation[index];
                if (!Number.isFinite(amount)) return null;
                const barHeight = amount / maxPrecipitation * (WEATHER_BOTTOM - WEATHER_TOP - 8);
                return (
                  <rect
                    key={`rain-${date.getTime()}`}
                    x={x(date.getTime()) + 1}
                    y={WEATHER_BOTTOM - barHeight}
                    width={Math.max(1, width - 2)}
                    height={barHeight}
                    rx="1"
                    fill="url(#meteogram-rain)"
                  />
                );
              })}
              {fields.precipitationProbability ? (
                <path
                  d={pathFor(
                    fields.precipitationProbability.dates,
                    probability,
                    x,
                    (value) => WEATHER_BOTTOM
                      - value / 100 * (WEATHER_BOTTOM - WEATHER_TOP),
                  )}
                  fill="none"
                  stroke="#63c9ff"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ) : null}
              {windSpeedSeries ? (
                <>
                  {windDistribution?.kind === "forecast"
                    && windDistribution.memberCount > 1 ? (
                      <>
                        <path
                          d={bandPath(
                            windDistribution,
                            x,
                            (value) => WIND_BOTTOM
                              - value / maxWind * (WIND_BOTTOM - WIND_TOP),
                          )}
                          fill="#9bd9ca"
                          fillOpacity=".13"
                        />
                        <path
                          d={bandPath(
                            windDistribution,
                            x,
                            (value) => WIND_BOTTOM
                              - value / maxWind * (WIND_BOTTOM - WIND_TOP),
                            "q25",
                            "q75",
                          )}
                          fill="#9bd9ca"
                          fillOpacity=".18"
                        />
                      </>
                    ) : null}
                  <path
                    d={pathFor(
                      windSpeedSeries.dates,
                      wind,
                      x,
                      (value) => WIND_BOTTOM
                        - value / maxWind * (WIND_BOTTOM - WIND_TOP),
                    )}
                    fill="none"
                    stroke="#9bd9ca"
                    strokeWidth="1.8"
                  />
                </>
              ) : null}
              {fields.windDirection?.dates.map((date, index) => {
                if (index % Math.max(1, Math.ceil(direction.length / 24)) !== 0) return null;
                const angle = direction[index];
                const speed = wind[index];
                if (!Number.isFinite(angle) || !Number.isFinite(speed)) return null;
                const arrowY = WIND_BOTTOM
                  - speed / maxWind * (WIND_BOTTOM - WIND_TOP);
                return (
                  <g
                    key={`wind-${date.getTime()}`}
                    transform={`translate(${x(date.getTime())} ${arrowY}) rotate(${windArrowRotation(angle)})`}
                  >
                    <path d="M0 7 L0 -7 M0 -7 L-3 -2 M0 -7 L3 -2" className="wind-arrow" />
                  </g>
                );
              })}
            </g>

            <line x1={LEFT} x2={RIGHT} y1={WEATHER_BOTTOM} y2={WEATHER_BOTTOM} className="panel-rule" />
            <line
              x1={LEFT}
              x2={RIGHT}
              y1={(WEATHER_TOP + WEATHER_BOTTOM) / 2}
              y2={(WEATHER_TOP + WEATHER_BOTTOM) / 2}
              className="value-grid"
            />
            <line x1={LEFT} x2={RIGHT} y1={WIND_BOTTOM} y2={WIND_BOTTOM} className="panel-rule" />
            <line
              x1={x(activeTimestamp)}
              x2={x(activeTimestamp)}
              y1={TEMP_TOP}
              y2={WIND_BOTTOM}
              className="active-time"
            />
          </svg>
        </HorizontalScrollWindow>
      ) : (
        <div className={`meteogram-status ${phase}`}>
          <span aria-hidden="true" />
          {message || "Preparing forecast…"}
        </div>
      )}
      {phase === "loading" && timeRange ? (
        <div className="meteogram-loading" aria-label="Loading forecast fields" />
      ) : null}
      {phase === "error" ? <div className="meteogram-error">{message}</div> : null}
    </section>
  );
}
