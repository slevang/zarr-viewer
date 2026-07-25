import {
  convertPointSeries,
  convertUnitRange,
  convertUnitValue,
  nativeUnitOption,
  unitKind,
  unitOptions,
} from "../app/units";

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

const precipitationOptions = unitOptions("m", "total_precipitation");
if (
  precipitationOptions.map((option) => option.id).join(",") !== "m,mm,in"
  || unitKind("m", "total_precipitation") !== "precipitation"
) {
  throw new Error("Precipitation did not receive m, mm, and inch display units");
}
close(convertUnitValue(273.15, "K", "tempC"), 0);
close(convertUnitValue(0, "degree_Celsius", "tempF"), 32);
const [low, high] = convertUnitRange([273.15, 303.15], "K", "tempC");
close(low, 0);
close(high, 30);

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
