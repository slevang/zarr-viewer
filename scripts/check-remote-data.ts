import { readFile } from "node:fs/promises";
import { IcechunkStore } from "icechunk-js";
import * as zarr from "zarrita";
import { initializePcodec } from "../app/codecs/pcodec";
import {
  getDataset,
  hasSeriesSource,
} from "../app/catalog";
import {
  defaultSelections,
  loadPointForecast,
  loadPointTimeSeries,
  loadStoreInfo,
} from "../app/dataset";

await initializePcodec(
  await readFile(
    new URL(
      "../packages/zarrita-pcodec/pkg/pcodec_wasm_bg.wasm",
      import.meta.url,
    ),
  ),
);

const googleEra5 = getDataset("google-arco-era5");
if (hasSeriesSource(googleEra5)) {
  throw new Error("Google ARCO ERA5 must not enable point time-series reads");
}
const hrrr = getDataset("noaa-hrrr-forecast-48-hour");
if (
  hrrr.sources.map?.id !== "noaa-hrrr-forecast-48-hour-virtual"
  || hrrr.sources.series?.id !== "noaa-hrrr-forecast-48-hour"
) {
  throw new Error("HRRR must pair its spatial map store with its temporal series store");
}

const hrrrStore = await IcechunkStore.open(
  "https://dynamical-noaa-hrrr.s3.us-west-2.amazonaws.com/noaa-hrrr-forecast-48-hour-virtual/v0.5.0.icechunk",
);
const hrrrArray = await zarr.open(
  zarr.root(hrrrStore).resolve("temperature_2m"),
  { kind: "array" },
);
const hrrrValue = await zarr.get(hrrrArray, [11733, 0, 529, 899]);

const hrrrInfo = await loadStoreInfo("noaa-hrrr-forecast-48-hour", "series");
const hrrrVariable = hrrrInfo.variables.find(
  (variable) => variable.id === "temperature_2m",
);
if (!hrrrVariable) throw new Error("Materialized HRRR did not report temperature_2m");
const hrrrSeries = await loadPointForecast(
  hrrrInfo,
  hrrrVariable,
  defaultSelections(hrrrInfo, hrrrVariable),
  -73.98,
  40.75,
);
if (!hrrrSeries || hrrrSeries.quantiles.length !== 49) {
  throw new Error("Materialized HRRR did not return its 49-hour point forecast");
}

const era5Info = await loadStoreInfo("earthmover-era5", "series");
const era5Variable = era5Info.variables.find((variable) => variable.id === "t2m");
if (!era5Variable) throw new Error("Earthmover ERA5 did not report t2m");
const era5Series = await loadPointTimeSeries(
  era5Info,
  era5Variable,
  defaultSelections(era5Info, era5Variable),
  -73.98,
  40.75,
);
if (!era5Series || era5Series.values.length !== 360) {
  throw new Error("Earthmover ERA5 did not return 15 days of hourly values");
}

const gefsInfo = await loadStoreInfo("noaa-gefs-forecast-35-day", "series");
const gefsVariable = gefsInfo.variables.find(
  (variable) => variable.id === "temperature_2m",
);
if (!gefsVariable) throw new Error("Dynamical GEFS did not report temperature_2m");
const gefsSeries = await loadPointForecast(
  gefsInfo,
  gefsVariable,
  defaultSelections(gefsInfo, gefsVariable),
  -73.98,
  40.75,
);
if (!gefsSeries || gefsSeries.memberCount !== 31 || !gefsSeries.quantiles.length) {
  throw new Error("Dynamical GEFS did not return a 31-member forecast");
}
const gefsDuration = (
  gefsSeries.dates.at(-1)!.getTime() - gefsSeries.dates[0].getTime()
);
if (gefsDuration > 15 * 24 * 60 * 60 * 1000) {
  throw new Error("Dynamical GEFS exceeded the 15-day comparison window");
}

console.log({
  virtualHrrrTemperature2m: hrrrValue,
  hrrrPointForecast: {
    steps: hrrrSeries.quantiles.length,
    first: hrrrSeries.dates[0].toISOString(),
    last: hrrrSeries.dates.at(-1)?.toISOString(),
  },
  era5PointSeries: {
    count: era5Series.values.length,
    first: era5Series.dates[0].toISOString(),
    last: era5Series.dates.at(-1)?.toISOString(),
    grid: [era5Series.longitude, era5Series.latitude],
  },
  gefsPointForecast: {
    members: gefsSeries.memberCount,
    steps: gefsSeries.quantiles.length,
    first: gefsSeries.dates[0].toISOString(),
    last: gefsSeries.dates.at(-1)?.toISOString(),
  },
});
