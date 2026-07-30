import * as zarr from "zarrita";
import {
  datasetChunkingLabel,
  getDataset,
} from "../app/catalog";
import {
  defaultSelections,
} from "../app/data/axes";
import {
  loadPointTimeSeries,
} from "../app/data/point-series";
import {
  loadStoreInfo,
} from "../app/dataset";
import {
  setCdsApiKey,
} from "../app/ecmwf-auth";

const cdsApiKey = process.env.CDSAPI_KEY?.trim();
if (!cdsApiKey) {
  throw new Error("Set CDSAPI_KEY before running the ECMWF ARCO live check");
}
setCdsApiKey(cdsApiKey);

const dataset = getDataset("ecmwf-arco-era5");
if (
  datasetChunkingLabel(dataset) !== "Dual-chunked"
  || dataset.sources.map?.layout !== "spatial"
  || dataset.sources.series?.layout !== "timeseries"
  || dataset.sources.map?.latIsAscending !== true
  || dataset.sources.series?.latIsAscending !== true
  || dataset.sources.map?.bounds?.[0] !== -180
  || dataset.sources.series?.bounds?.[0] !== -180
) {
  throw new Error("ECMWF ERA5 did not retain its role-optimized source pairing");
}

const mapInfo = await loadStoreInfo(dataset.id, "map");
const mapTemperature = mapInfo.variables.find(
  (variable) => variable.id === "t2m",
);
if (
  !mapTemperature
  || mapTemperature.chunkShape?.[0] !== 1
  || mapTemperature.chunkShape?.[1] !== 721
) {
  throw new Error("ECMWF time-chunked ERA5 did not report the expected t2m layout");
}
const mapSelections = defaultSelections(mapInfo, mapTemperature);
const mapArray = await zarr.open(
  zarr.root(mapInfo.store!).resolve("t2m"),
  { kind: "array" },
);
const [mapLatitudes, mapLongitudes] = await Promise.all([
  zarr.get(await zarr.open(
    zarr.root(mapInfo.store!).resolve("latitude"),
    { kind: "array" },
  )),
  zarr.get(await zarr.open(
    zarr.root(mapInfo.store!).resolve("longitude"),
    { kind: "array" },
  )),
]);
const latitudeEndpoints = [
  Number(mapLatitudes.data[0]),
  Number(mapLatitudes.data[mapLatitudes.data.length - 1]),
];
const longitudeEndpoints = [
  Number(mapLongitudes.data[0]),
  Number(mapLongitudes.data[mapLongitudes.data.length - 1]),
];
if (
  latitudeEndpoints[0] !== -90
  || latitudeEndpoints[1] !== 90
  || longitudeEndpoints[0] !== -180
  || longitudeEndpoints[1] !== 179.75
) {
  throw new Error("ECMWF ERA5 coordinate arrays changed orientation or extent");
}
const mapValue = await zarr.get(mapArray, [
  mapSelections.time,
  360,
  720,
]);
const latestMapValue = Number(mapValue);
if (!Number.isFinite(latestMapValue)) {
  throw new Error("ECMWF time-chunked ERA5 returned a non-finite map value");
}

const seriesInfo = await loadStoreInfo(dataset.id, "series");
const seriesTemperature = seriesInfo.variables.find(
  (variable) => variable.id === "t2m",
);
if (
  !seriesTemperature
  || seriesTemperature.chunkShape?.[1] !== 4
  || seriesTemperature.chunkShape?.[2] !== 4
) {
  throw new Error("ECMWF geo-chunked ERA5 did not report the expected t2m layout");
}
const series = await loadPointTimeSeries(
  seriesInfo,
  seriesTemperature,
  defaultSelections(seriesInfo, seriesTemperature),
  -71.06,
  42.36,
);
if (!series || series.values.length !== 360) {
  throw new Error("ECMWF geo-chunked ERA5 did not return a 15-day point series");
}

console.log({
  dataset: dataset.id,
  map: {
    variables: mapInfo.variables.length,
    timeSteps: mapInfo.axes.time?.values.length,
    chunks: mapTemperature.chunkShape,
    latitude: latitudeEndpoints,
    longitude: longitudeEndpoints,
    latestValue: latestMapValue,
  },
  series: {
    variables: seriesInfo.variables.length,
    timeSteps: seriesInfo.axes.time?.values.length,
    chunks: seriesTemperature.chunkShape,
    points: series.values.length,
    first: series.dates[0]?.toISOString(),
    last: series.dates.at(-1)?.toISOString(),
    grid: [series.longitude, series.latitude],
  },
});
