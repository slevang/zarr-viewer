import {
  convertPointSeries,
  convertUnitRange,
  convertUnitValue,
  nativeUnitOption,
  precipitationRateConverter,
  precipitationRateUnitOption,
  unitKind,
  unitOptions,
} from "../app/units";
import { weatherNextVariableUnit } from "../app/dataset";

function close(actual: number, expected: number) {
  if (Math.abs(actual - expected) > 1e-9) {
    throw new Error(`Expected ${expected}; received ${actual}`);
  }
}

if (unitKind("K") !== "temperature") {
  throw new Error("CF kelvin metadata was not recognized as temperature");
}
if (unitKind("degree_Celsius") !== "temperature") {
  throw new Error("CF Celsius metadata was not recognized as temperature");
}
const options = unitOptions("K");
if (!["tempK", "tempC", "tempF"].every((unit) =>
  options.some((candidate) => candidate.id === unit)
)) {
  throw new Error("Temperature did not expose K, °C, and °F");
}
if (nativeUnitOption("degree_Celsius")?.id !== "tempC") {
  throw new Error("Celsius did not resolve to its absolute-temperature unit");
}
if (
  weatherNextVariableUnit("2m_temperature") !== "K"
  || weatherNextVariableUnit("total_precipitation_6hr") !== "m"
) {
  throw new Error("WeatherNext unit fallback metadata is incomplete");
}

const precipitationOptions = unitOptions("m", "total_precipitation");
if (
  precipitationOptions.map((option) => option.id).join(",") !== "m,mm,in"
  || unitKind("m", "total_precipitation") !== "precipitation"
) {
  throw new Error("Precipitation did not receive m, mm, and inch display units");
}
const hrrrPrecipitationOptions = unitOptions(
  "kg m-2",
  "total_precipitation_surface Total precipitation",
);
if (
  hrrrPrecipitationOptions.map((option) => option.id).join(",")
    !== "kg/m2,m,mm,in"
  || unitKind(
    "kg m-2",
    "total_precipitation_surface Total precipitation",
  ) !== "precipitation"
) {
  throw new Error("Water-equivalent precipitation did not expose mm and inches");
}
close(
  convertUnitValue(
    25.4,
    "kg m-2",
    "in",
    "total_precipitation_surface Total precipitation",
  ),
  1,
);
close(
  convertUnitValue(
    0.1,
    "mm",
    "kg m-2",
    "total_precipitation_surface Total precipitation",
  ),
  0.1,
);
const hrrrRateConverter = precipitationRateConverter(
  "kg m-2 s-1",
  "precipitation_surface Precipitation rate precipitation_flux",
);
if (!hrrrRateConverter) {
  throw new Error("HRRR precipitation flux did not expose a step converter");
}
close(hrrrRateConverter(1e-5, 3600), 0.036);
const precipitationRateOptions = unitOptions(
  "mm/h",
  "Precipitation rate",
);
if (
  precipitationRateOptions.map((option) => option.id).join(",")
    !== "mm/h,in/h"
  || unitKind("mm/h", "Precipitation rate") !== "precipitation_rate"
) {
  throw new Error("Precipitation rate did not expose mm/hr and in/hr");
}
close(
  convertUnitValue(25.4, "mm/h", "in/h", "Precipitation rate"),
  1,
);
if (
  precipitationRateUnitOption("mm").id !== "mm/h"
  || precipitationRateUnitOption("in").id !== "in/h"
  || precipitationRateUnitOption("in/h").id !== "in/h"
) {
  throw new Error("Precipitation amount preferences did not map to rate units");
}
close(convertUnitValue(273.15, "K", "tempC"), 0);
close(convertUnitValue(0, "degree_Celsius", "tempF"), 32);
const [low, high] = convertUnitRange([273.15, 303.15], "K", "tempC");
close(low, 0);
close(high, 30);
if (
  unitKind("degree_day_K") !== "degree_day"
  || unitOptions("degree_day_K").map((option) => option.id).join(",")
    !== "degreeDayK,degreeDayC,degreeDayF"
) {
  throw new Error("Degree-day units were not kept separate from absolute temperature");
}
close(convertUnitValue(10, "degree_day_K", "degreeDayF"), 18);
close(convertUnitValue(18, "degree_day_F", "degreeDayC"), 10);

const converted = convertPointSeries({
  kind: "history",
  values: [273.15, 293.15],
  dates: [new Date(0), new Date(1)],
  unit: "K",
  variableLabel: "Temperature",
  latitude: 0,
  longitude: 0,
}, { id: "tempC", label: "°C" });
if (converted.kind !== "history" || converted.unit !== "°C") {
  throw new Error("Point-series units were not converted");
}
close(converted.values[0], 0);
close(converted.values[1], 20);

console.log("Unit conversion checks passed");
