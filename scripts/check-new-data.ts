import { readFile } from "node:fs/promises";
import * as zarr from "zarrita";
import { initializePcodec } from "../app/codecs/pcodec";
import {
  defaultSelections,
  loadPointForecast,
  loadStoreInfo,
} from "../app/dataset";
import { isSpatialDimension } from "../app/data/dimensions";
import {
  variableLayerOptions,
  variableLayerUnit,
} from "../app/derived-store";

await initializePcodec(
  await readFile(
    new URL(
      "../packages/zarrita-pcodec/pkg/pcodec_wasm_bg.wasm",
      import.meta.url,
    ),
  ),
);

function scalarValue(result: unknown) {
  const data = result && typeof result === "object" && "data" in result
    ? result.data
    : result;
  return Array.isArray(data) || ArrayBuffer.isView(data)
    ? Number((data as ArrayLike<number | bigint>)[0])
    : Number(data);
}

const weatherZarr = await loadStoreInfo("weatherzarr-ecmwf-ifs", "map");
const weatherZarrTemperature = weatherZarr.variables.find(
  (variable) => variable.id === "2t",
);
if (!weatherZarrTemperature) {
  throw new Error("WeatherZarr IFS did not report 2t");
}
if (
  weatherZarr.axes.init_time?.kind !== "time"
  || !weatherZarr.axes.init_time.requiresStoreReload
  || weatherZarr.axes.init_time.values.length < 2
) {
  throw new Error("WeatherZarr IFS did not report its rolling initialization archive");
}
if (
  weatherZarr.axes.valid_time?.kind !== "timedelta"
  || weatherZarr.axes.valid_time.label !== "Lead time"
  || !Number.isFinite(Number(weatherZarr.axes.valid_time.values[0]))
  || Number(weatherZarr.axes.valid_time.values[0]) < 0
) {
  throw new Error("WeatherZarr IFS did not normalize valid_time to forecast lead");
}
const weatherZarrArray = await zarr.open(
  zarr.root(weatherZarr.store!).resolve("2t"),
  { kind: "array" },
);
const weatherZarrValue = await zarr.get(weatherZarrArray, [0, 360, 720]);
const weatherZarrLatitude = await zarr.open(
  zarr.root(weatherZarr.store!).resolve("latitude"),
  { kind: "array" },
);
const weatherZarrLatitudeValues = await zarr.get(weatherZarrLatitude);
const weatherZarrPrecipitation = weatherZarr.variables.find(
  (variable) => variable.id === "tp",
);
if (!weatherZarrPrecipitation?.shape) {
  throw new Error("WeatherZarr IFS did not report total precipitation");
}
const precipitationLeadDimension = weatherZarrPrecipitation.dimensions.findIndex(
  (dimension) => weatherZarr.axes[dimension]?.kind === "timedelta",
);
if (precipitationLeadDimension < 0) {
  throw new Error("WeatherZarr precipitation did not report a lead-time axis");
}
const precipitationCurrentSelection = weatherZarrPrecipitation.dimensions.map(
  (dimension, index) => {
    if (index === precipitationLeadDimension) return 1;
    return isSpatialDimension(dimension, weatherZarr.source)
      ? Math.floor((weatherZarrPrecipitation.shape?.[index] ?? 1) / 2)
      : 0;
  },
);
const precipitationPreviousSelection = [...precipitationCurrentSelection];
precipitationPreviousSelection[precipitationLeadDimension] = 0;
const weatherZarrPrecipitationArray = await zarr.open(
  zarr.root(weatherZarr.store!).resolve(weatherZarrPrecipitation.id),
  { kind: "array" },
);
const [rawPreviousPrecipitation, rawCurrentPrecipitation] = await Promise.all([
  zarr.get(weatherZarrPrecipitationArray, precipitationPreviousSelection),
  zarr.get(weatherZarrPrecipitationArray, precipitationCurrentSelection),
]);
const precipitationLayerOptions = await variableLayerOptions(
  weatherZarr,
  weatherZarrPrecipitation,
);
const ratePrecipitationArray = await zarr.open(
  zarr.root(precipitationLayerOptions.store!).resolve(
    weatherZarrPrecipitation.id,
  ),
  { kind: "array" },
);
const ratePrecipitation = await zarr.get(
  ratePrecipitationArray,
  precipitationCurrentSelection,
);
const rawPreviousPrecipitationValue = scalarValue(rawPreviousPrecipitation);
const rawCurrentPrecipitationValue = scalarValue(rawCurrentPrecipitation);
const ratePrecipitationValue = scalarValue(ratePrecipitation);
const previousLead = Number(weatherZarr.axes.valid_time.values[0]);
const currentLead = Number(weatherZarr.axes.valid_time.values[1]);
const expectedRatePrecipitation = Math.max(
  0,
  rawCurrentPrecipitationValue - rawPreviousPrecipitationValue,
) * 1000 / (currentLead - previousLead);
if (
  !Number.isFinite(rawPreviousPrecipitationValue)
  || !Number.isFinite(rawCurrentPrecipitationValue)
  || !Number.isFinite(ratePrecipitationValue)
  || variableLayerUnit(weatherZarr, weatherZarrPrecipitation) !== "mm/h"
  || Math.abs(ratePrecipitationValue - expectedRatePrecipitation) > 1e-7
) {
  throw new Error(
    "WeatherZarr precipitation was not converted to a finite hourly rate:"
    + ` ${rawPreviousPrecipitationValue} → ${rawCurrentPrecipitationValue}`
    + ` produced ${ratePrecipitationValue}`,
  );
}

const weatherZarrSeriesInfo = await loadStoreInfo(
  "weatherzarr-ecmwf-ifs",
  "series",
);
const weatherZarrSeriesVariable = weatherZarrSeriesInfo.variables.find(
  (variable) => variable.id === "2t",
);
if (!weatherZarrSeriesVariable) {
  throw new Error("WeatherZarr IFS point layout did not report 2t");
}
const weatherZarrSeries = await loadPointForecast(
  weatherZarrSeriesInfo,
  weatherZarrSeriesVariable,
  defaultSelections(weatherZarrSeriesInfo, weatherZarrSeriesVariable),
  -71.06,
  42.36,
);
if (!weatherZarrSeries?.quantiles.length) {
  throw new Error("WeatherZarr IFS did not return a point series");
}

const gem = await loadStoreInfo("salient-gemai-v3-reforecast", "series");
const gemTemperature = gem.variables.find(
  (variable) => variable.id === "2m_temperature",
);
if (!gemTemperature) {
  throw new Error("GemAI v3 did not report 2m_temperature");
}
const gemLatitude = await zarr.open(
  zarr.root(gem.store!).resolve("lat"),
  { kind: "array" },
);
const gemLatitudeValues = await zarr.get(gemLatitude);
const gemSelections = defaultSelections(gem, gemTemperature);
gemSelections.forecast_date = gem.axes.forecast_date.values.length - 1;
const gemSeries = await loadPointForecast(
  gem,
  gemTemperature,
  gemSelections,
  -71.06,
  42.36,
);
if (!gemSeries?.quantiles.length || gemSeries.memberCount !== 50) {
  throw new Error("GemAI v3 did not return its 50-member point forecast");
}

console.log({
  weatherZarr: {
    variables: weatherZarr.variables.map((variable) => variable.id),
    axes: Object.fromEntries(
      Object.entries(weatherZarr.axes).map(([id, axis]) => [
        id,
        {
          kind: axis.kind,
          unit: axis.unit,
          count: axis.values.length,
          first: String(axis.values[0]),
          last: String(axis.values.at(-1)),
        },
      ]),
    ),
    mapValue: weatherZarrValue,
    precipitationAccumulation: [
      rawPreviousPrecipitationValue,
      rawCurrentPrecipitationValue,
    ],
    ratePrecipitation: ratePrecipitationValue,
    latitude: [
      Number(weatherZarrLatitudeValues.data[0]),
      Number(weatherZarrLatitudeValues.data[weatherZarrLatitudeValues.data.length - 1]),
    ],
    seriesCount: weatherZarrSeries.quantiles.length,
  },
  gem: {
    variables: gem.variables.map((variable) => variable.id),
    axes: Object.fromEntries(
      Object.entries(gem.axes).map(([id, axis]) => [
        id,
        {
          kind: axis.kind,
          unit: axis.unit,
          count: axis.values.length,
          first: String(axis.values[0]),
          last: String(axis.values.at(-1)),
        },
      ]),
    ),
    seriesCount: gemSeries.quantiles.length,
    members: gemSeries.memberCount,
    firstMedian: gemSeries.quantiles[0]?.q50,
    latitude: [
      Number(gemLatitudeValues.data[0]),
      Number(gemLatitudeValues.data[gemLatitudeValues.data.length - 1]),
    ],
  },
});
