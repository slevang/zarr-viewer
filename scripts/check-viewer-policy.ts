import assert from "node:assert/strict";
import {
  DATASETS,
  getDataset,
  getDatasetSource,
} from "../app/catalog";
import type { AxisConfig, VariableConfig } from "../app/data/types";
import {
  formatRangeValue,
  initialDisplayRange,
  roundRangeToSignificant,
} from "../app/viewer/display";
import {
  isRainVariable,
  MINIMUM_VISIBLE_SMOKE_RANGE_FRACTION,
  MINIMUM_VISIBLE_PRECIPITATION_RATE_MM_H,
  variableFragmentShader,
} from "../app/viewer/rendering";
import {
  hrrrSmokeVariables,
  isHrrrSmokeVariable,
} from "../app/viewer/smoke";
import { PRECIPITATION_EVENT_THRESHOLD_MM } from "../app/precipitation";
import { matchingVariable } from "../app/viewer/variables";
import { defaultColormap } from "../app/colormaps";
import {
  playbackChunkKey,
  playbackInterval,
  playbackPrefetchProfile,
} from "../app/viewer/playback";
import {
  datasetPreloadRequests,
  runDatasetPreloads,
} from "../app/viewer/dataset-preload";
import {
  baseViewerUrl,
  viewerLocationFromUrl,
  viewerShareUrl,
} from "../app/viewer/preferences";
import { stationFromFeature } from "../app/viewer/stations";
import {
  meteogramComparisonDatasets,
  preferredRegionalMeteogramDataset,
  meteogramDayTicks,
  meteogramHoverTimestamps,
  meteogramStartSelections,
  nearestTimestamp,
  normalizeMeteogramPercentSeries,
  stitchMeteogramSeries,
  trimMeteogramSeries,
  windArrowRotation,
} from "../app/viewer/meteogram";
import {
  FORECAST_WINDOW_DAYS,
  timelineRangeDays,
  timelineWidthPercent,
} from "../app/viewer/timeline";
import {
  formatLocalTimeIndicator,
  formatLocalTimestamp,
  formatUtcTick,
  formatUtcTimeIndicator,
  formatUtcTimestamp,
  timeZoneAt,
} from "../app/viewer/time-zone";

const dataset = getDataset("google-arco-era5");
const timezoneTestDate = new Date("2026-07-30T12:05:00Z");
assert.equal(timeZoneAt(40.7128, -74.006), "America/New_York");
assert.equal(timeZoneAt(Number.NaN, -74.006), "UTC");
assert.equal(
  formatUtcTimeIndicator(timezoneTestDate),
  "Thu, Jul 30, 1205 UTC",
);
assert.match(
  formatLocalTimeIndicator(timezoneTestDate, "America/New_York"),
  /^Thu, Jul 30, 0805 (EDT|GMT-4) · local$/,
);
assert.equal(formatUtcTimestamp(timezoneTestDate), "2026-07-30 1205Z");
assert.match(
  formatLocalTimestamp(timezoneTestDate, "America/New_York"),
  /^2026-07-30 0805 (EDT|GMT-4) · local$/,
);
assert.equal(formatUtcTick(timezoneTestDate, true), "Jul 30 1205Z");
assert.equal(formatUtcTick(timezoneTestDate, false), "Jul 30");
assert.equal(
  getDataset("weatherzarr-ecmwf-ifs").sources.map
    ?.precipitationAccumulation,
  "cumulative",
);
assert.equal(
  getDataset("weatherzarr-ecmwf-ifs").sources.series
    ?.precipitationAccumulation,
  "cumulative",
);
assert.equal(
  getDataset("noaa-hrrr-forecast-48-hour").sources.map
    ?.requiresCrossOriginIsolation,
  true,
);
assert.equal(
  getDataset("noaa-hrrr-forecast-48-hour").sources.series
    ?.requiresCrossOriginIsolation,
  undefined,
);
assert.equal(
  baseViewerUrl("https://example.com/viewer/?dataset=old#map"),
  "https://example.com/viewer/",
);
assert.equal(
  viewerShareUrl("https://example.com/viewer/?stale=true#map", {
    datasetId: "google-arco-era5",
    mode: "meteogram",
    screen: "forecast",
    latitude: 42.3601,
    longitude: -71.0589,
    centerLatitude: 40.712776,
    centerLongitude: -74.005974,
    zoom: 6.12345,
    variableId: "2m_temperature",
    axisValues: {
      time: "2026-07-30T12:00:00.000Z",
      level: "850",
    },
    colormapId: "viridis",
    opacity: 0.8,
    displayUnit: "tempC",
    displayRange: [-10, 35],
    projection: "mercator",
  }),
  "https://example.com/viewer/?dataset=google-arco-era5&view=meteogram&screen=forecast&centerLat=40.71278&centerLon=-74.00597&zoom=6.123&lat=42.3601&lon=-71.0589&variable=2m_temperature&sel.time=2026-07-30T12%3A00%3A00.000Z&sel.level=850&colormap=viridis&opacity=0.8&unit=tempC&min=-10&max=35&projection=mercator",
);
assert.deepEqual(
  viewerLocationFromUrl(
    "https://example.com/viewer/?centerLat=40.71278&centerLon=-74.00597&zoom=6.123",
  ),
  {
    mode: "series",
    screen: "map",
    axisValues: {},
    station: undefined,
    latitude: undefined,
    longitude: undefined,
    centerLatitude: 40.71278,
    centerLongitude: -74.00597,
    zoom: 6.123,
    variableId: undefined,
    colormapId: undefined,
    opacity: undefined,
    displayUnit: undefined,
    displayRange: undefined,
    projection: undefined,
  },
);
const timeAxis: AxisConfig = {
  id: "time",
  label: "Time",
  unit: "hours since 2020-01-01 00:00:00",
  kind: "time",
  values: [0, 6],
};
assert.equal(playbackInterval(dataset, timeAxis, 0, 1), 1_000);

const temperature: VariableConfig = {
  id: "temperature",
  label: "2 metre temperature",
  unit: "K",
  dimensions: ["time", "latitude", "longitude"],
  shape: [10, 180, 360],
  chunkShape: [2, 180, 360],
  dataType: "float32",
};
assert.equal(
  playbackChunkKey(temperature, { time: 4 }),
  "/temperature/c/2/0/0",
);
assert.deepEqual(initialDisplayRange(temperature), [230, 320]);
assert.equal(formatRangeValue(273.156, [230, 320]), "273.2");
assert.equal(formatRangeValue(1.234e-8, [0, 1e-7]), "1.23e-8");
assert.equal(formatRangeValue(0, [0, 1e-7]), "0");
assert.equal(defaultColormap(temperature).id, "thermal");
const precipitation: VariableConfig = {
  ...temperature,
  id: "tp",
  label: "Total precipitation",
  unit: "m",
};
assert.equal(isRainVariable(precipitation), true);
assert.equal(defaultColormap(precipitation).id, "rain");
assert.equal(PRECIPITATION_EVENT_THRESHOLD_MM, 0.1);
assert.equal(MINIMUM_VISIBLE_PRECIPITATION_RATE_MM_H, 0.03);
assert.deepEqual(initialDisplayRange(precipitation, "mm/h"), [0, 5]);
assert.match(
  variableFragmentShader(precipitation, "mm/h") ?? "",
  /tp <= 0\.03/,
);
assert.match(
  variableFragmentShader({
    ...precipitation,
    id: "total_precipitation_surface",
    unit: "kg m-2",
  }, "mm/h") ?? "",
  /total_precipitation_surface <= 0\.03/,
);
assert.equal(variableFragmentShader(temperature), undefined);
const hrrrSmoke = {
  ...temperature,
  id: "mass_density_8m",
  label: "Mass density",
  unit: "kg m-3",
};
assert.equal(isHrrrSmokeVariable(hrrrSmoke), true);
assert.equal(defaultColormap(hrrrSmoke).id, "smoke");
assert.equal(MINIMUM_VISIBLE_SMOKE_RANGE_FRACTION, 0.1);
assert.match(
  variableFragmentShader(hrrrSmoke) ?? "",
  /mass_density_8m <= \(clim\.x \+ \(clim\.y - clim\.x\) \* 0\.1\)/,
);
assert.deepEqual(
  hrrrSmokeVariables("noaa-hrrr-forecast-48-hour", [hrrrSmoke]),
  [hrrrSmoke],
);
assert.deepEqual(hrrrSmokeVariables("noaa-hrrr-analysis", [hrrrSmoke]), []);
const matchingPrecipitation = matchingVariable({
  dataset,
  source: getDatasetSource(dataset, "map")!,
  role: "map",
  axes: {},
  variables: [{
    ...precipitation,
    id: "total_precipitation_surface",
    unit: "kg m-2",
  }],
  layerOptions: {
    zarrVersion: 3,
    crs: "EPSG:4326",
  },
}, precipitation);
assert.equal(matchingPrecipitation?.id, "total_precipitation_surface");
assert.deepEqual(
  roundRangeToSignificant([0.123456789, 9876.54321]),
  [0.123457, 9876.54],
);

const source = getDatasetSource(dataset, "map");
assert.ok(source);
const profile = playbackPrefetchProfile(source, temperature, timeAxis);
assert.ok(profile.ahead > 0);
assert.ok(profile.concurrency >= 1);
const directSource = getDatasetSource(getDataset("earthmover-era5"), "map");
assert.ok(directSource);
assert.equal(
  playbackPrefetchProfile(directSource, temperature, timeAxis).directChunkReads,
  true,
);
const ecmwfEra5 = getDataset("ecmwf-arco-era5");
assert.equal(ecmwfEra5.sources.map?.auth, "cds-api-key");
assert.equal(ecmwfEra5.sources.map?.layout, "spatial");
assert.equal(ecmwfEra5.sources.series?.layout, "timeseries");
assert.equal(ecmwfEra5.sources.map?.kind, "ecmwf-arco");
assert.equal(ecmwfEra5.sources.series?.kind, "ecmwf-arco");
assert.equal(ecmwfEra5.sources.map?.latIsAscending, true);
assert.equal(ecmwfEra5.sources.series?.latIsAscending, true);
assert.deepEqual(ecmwfEra5.sources.map?.bounds, [-180, -90, 180, 90]);
assert.deepEqual(ecmwfEra5.sources.series?.bounds, [-180, -90, 180, 90]);

assert.deepEqual(
  stationFromFeature({
    geometry: { type: "Point", coordinates: [-73.78, 40.64] },
    properties: {
      station: "KJFK",
      name: "John F Kennedy International",
      state: "NY",
      country: "US",
      elevation: 4,
    },
  }),
  {
    station: "KJFK",
    name: "John F Kennedy International",
    state: "NY",
    country: "US",
    elevation: 4,
    longitude: -73.78,
    latitude: 40.64,
  },
);
assert.equal(
  stationFromFeature({
    geometry: { type: "LineString", coordinates: [] },
    properties: { station: "invalid" },
  }),
  null,
);

const bostonMeteogramModels = meteogramComparisonDatasets(
  DATASETS,
  -71.06,
  42.36,
);
assert.deepEqual(
  bostonMeteogramModels.map((candidate) => candidate.id),
  [
    "noaa-hrrr-forecast-48-hour",
    "ecmwf-ifs-ens-forecast-15-day-0-25-degree",
  ],
);
assert.equal(
  preferredRegionalMeteogramDataset(DATASETS, -71.06, 42.36)?.id,
  "noaa-hrrr-forecast-48-hour",
);
assert.equal(windArrowRotation(225), 45);
assert.equal(FORECAST_WINDOW_DAYS, 7);
assert.equal(
  timelineRangeDays(
    new Date("2026-07-20T00:00:00Z").getTime(),
    new Date("2026-08-04T00:00:00Z").getTime(),
  ),
  15,
);
assert.equal(
  timelineWidthPercent(
    new Date("2026-07-20T00:00:00Z").getTime(),
    new Date("2026-07-27T00:00:00Z").getTime(),
  ),
  100,
);
assert.equal(
  Math.round(timelineWidthPercent(
    new Date("2026-07-20T00:00:00Z").getTime(),
    new Date("2026-08-04T00:00:00Z").getTime(),
  )),
  214,
);
assert.deepEqual(
  meteogramComparisonDatasets(DATASETS, 13.4, 52.5).map(
    (candidate) => candidate.id,
  ),
  [
    "dwd-icon-eu-forecast-5-day",
    "ecmwf-ifs-ens-forecast-15-day-0-25-degree",
  ],
);
assert.equal(
  preferredRegionalMeteogramDataset(DATASETS, 13.4, 52.5)?.id,
  "dwd-icon-eu-forecast-5-day",
);
assert.equal(
  getDataset("noaa-hrrr-forecast-48-hour")
    .sources.series?.meteogram?.firstLeadHour,
  1,
);
assert.equal(
  getDataset("noaa-hrrr-forecast-48-hour").defaultVariable,
  "total_precipitation_surface",
);
assert.equal(
  getDataset("noaa-hrrr-forecast-48-hour")
    .sources.map?.meteogram?.firstLeadHour,
  1,
);
assert.equal(
  getDataset("ecmwf-ifs-ens-forecast-15-day-0-25-degree")
    .sources.series?.meteogram?.firstLeadHour,
  3,
);
assert.equal(
  getDataset("weatherzarr-ecmwf-ifs")
    .sources.map?.meteogram?.firstLeadHour,
  3,
);
const trimmedForecast = trimMeteogramSeries({
  kind: "forecast",
  dates: [
    new Date("2026-07-20T00:00:00Z"),
    new Date("2026-07-20T01:00:00Z"),
    new Date("2026-07-20T02:00:00Z"),
  ],
  quantiles: [
    { q10: 0, q25: 0, q50: 0, q75: 0, q90: 0 },
    { q10: 1, q25: 1, q50: 1, q75: 1, q90: 1 },
    { q10: 2, q25: 2, q50: 2, q75: 2, q90: 2 },
  ],
  memberCount: 2,
  unit: "mm",
}, 1);
assert.deepEqual(
  trimmedForecast.dates.map((date) => date.toISOString()),
  ["2026-07-20T01:00:00.000Z", "2026-07-20T02:00:00.000Z"],
);
const hoverTimestamps = meteogramHoverTimestamps([
  {
    kind: "history",
    dates: [
      new Date("2026-07-20T01:00:00Z"),
      new Date("2026-07-20T02:00:00Z"),
      new Date("2026-07-20T03:00:00Z"),
      new Date("2026-07-20T04:00:00Z"),
    ],
    values: [1, 2, 3, 4],
    unit: "K",
  },
  {
    kind: "history",
    dates: [
      new Date("2026-07-20T03:00:00Z"),
      new Date("2026-07-20T06:00:00Z"),
      new Date("2026-07-20T09:00:00Z"),
    ],
    values: [3, 6, 9],
    unit: "K",
  },
]);
assert.deepEqual(
  hoverTimestamps.map((timestamp) => new Date(timestamp).toISOString()),
  [
    "2026-07-20T01:00:00.000Z",
    "2026-07-20T02:00:00.000Z",
    "2026-07-20T03:00:00.000Z",
    "2026-07-20T04:00:00.000Z",
    "2026-07-20T06:00:00.000Z",
    "2026-07-20T09:00:00.000Z",
  ],
);
assert.equal(
  nearestTimestamp(
    hoverTimestamps,
    new Date("2026-07-20T04:40:00Z").getTime(),
  ),
  new Date("2026-07-20T04:00:00Z").getTime(),
);
assert.equal(
  nearestTimestamp(
    hoverTimestamps,
    new Date("2026-07-20T05:10:00Z").getTime(),
  ),
  new Date("2026-07-20T06:00:00Z").getTime(),
);
const stitchedForecast = stitchMeteogramSeries({
  kind: "history",
  dates: [
    new Date("2026-07-20T01:00:00Z"),
    new Date("2026-07-20T02:00:00Z"),
  ],
  values: [10, 20],
  unit: "m/s",
  variableLabel: "Regional wind",
  latitude: 42,
  longitude: -71,
}, {
  kind: "history",
  dates: [
    new Date("2026-07-20T00:00:00Z"),
    new Date("2026-07-20T03:00:00Z"),
  ],
  values: [1, 3],
  unit: "m/s",
  variableLabel: "Ensemble wind",
  latitude: 42,
  longitude: -71,
});
assert.equal(stitchedForecast?.kind, "history");
assert.deepEqual(
  stitchedForecast?.kind === "history" ? stitchedForecast.values : [],
  [1, 10, 20, 3],
);
const normalizedCloud = normalizeMeteogramPercentSeries({
  kind: "history",
  dates: [new Date("2026-07-20T00:00:00Z")],
  values: [0.75],
  unit: "1",
  variableLabel: "Cloud cover",
  latitude: 42,
  longitude: -71,
});
assert.deepEqual(
  normalizedCloud?.kind === "history" ? normalizedCloud.values : [],
  [75],
);
const dailyTicks = meteogramDayTicks(
  new Date("2026-07-20T18:00:00Z").getTime(),
  new Date("2026-08-04T06:00:00Z").getTime(),
);
assert.equal(dailyTicks.length, 15);
assert.equal(
  dailyTicks[0]?.timestamp,
  new Date("2026-07-21T00:00:00Z").getTime(),
);
assert.ok(
  dailyTicks.every(
    (tick, index) =>
      index === 0
      || tick.timestamp - dailyTicks[index - 1].timestamp
        === 24 * 60 * 60 * 1000,
  ),
);
assert.deepEqual(
  dailyTicks.slice(0, 5).map((tick) => tick.showLabel),
  [true, false, true, false, true],
);
const forecastSource = getDatasetSource(
  getDataset("noaa-hrrr-forecast-48-hour"),
  "map",
);
assert.ok(forecastSource);
assert.deepEqual(
  meteogramStartSelections({
    dataset: getDataset("noaa-hrrr-forecast-48-hour"),
    source: forecastSource,
    role: "map",
    axes: {
      lead_time: {
        id: "lead_time",
        label: "Forecast lead time",
        unit: "seconds",
        kind: "timedelta",
        values: [0, 3600, 7200],
      },
    },
    variables: [],
  }, {
    ...temperature,
    dimensions: ["lead_time", "latitude", "longitude"],
  }, {
    lead_time: 0,
  }),
  { lead_time: 1 },
);

const preloadTargetDate = new Date("2026-07-20T12:00:00Z");
const activePreloadTargetDate = new Date("2026-07-20T00:00:00Z");
const preloadRequests = datasetPreloadRequests(DATASETS, {
  activeDatasetId: "weatherzarr-ecmwf-ifs",
  targetDate: preloadTargetDate,
  activeDatasetTargetDate: activePreloadTargetDate,
});
assert.equal(preloadRequests[0]?.role, "series");
assert.equal(
  preloadRequests.find(
    (request) =>
      request.datasetId === "weatherzarr-ecmwf-ifs"
      && request.role === "series",
  )?.targetDate,
  activePreloadTargetDate,
);
assert.equal(
  preloadRequests.some(
    (request) =>
      request.datasetId === "weatherzarr-ecmwf-ifs"
      && request.role === "map",
  ),
  false,
);
assert.equal(
  preloadRequests.some(
    (request) => getDataset(request.datasetId).sources[request.role]?.auth,
  ),
  false,
);
assert.equal(
  datasetPreloadRequests(DATASETS, {
    activeDatasetId: "weatherzarr-ecmwf-ifs",
    includeAuthenticated: true,
  }).some(
    (request) => getDataset(request.datasetId).sources[request.role]?.auth,
  ),
  true,
);
const ecmwfAuthenticatedPreloads = datasetPreloadRequests(DATASETS, {
  activeDatasetId: "weatherzarr-ecmwf-ifs",
  availableAuth: ["cds-api-key"],
});
assert.equal(
  ecmwfAuthenticatedPreloads.some(
    (request) => request.datasetId === "ecmwf-arco-era5",
  ),
  true,
);
assert.equal(
  ecmwfAuthenticatedPreloads.some(
    (request) => request.datasetId === "google-weathernext-2",
  ),
  false,
);

let activePreloads = 0;
let maximumActivePreloads = 0;
let completedPreloads = 0;
const preloadFailures = await runDatasetPreloads(
  preloadRequests.slice(0, 5),
  async () => {
    activePreloads += 1;
    maximumActivePreloads = Math.max(maximumActivePreloads, activePreloads);
    await new Promise((resolve) => setTimeout(resolve, 2));
    activePreloads -= 1;
    completedPreloads += 1;
    if (completedPreloads === 2) throw new Error("expected preload failure");
  },
  2,
);
assert.equal(maximumActivePreloads, 2);
assert.equal(completedPreloads, 5);
assert.equal(preloadFailures.length, 1);

console.log("Viewer policy checks passed");
