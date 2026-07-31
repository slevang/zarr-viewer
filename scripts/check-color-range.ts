import {
  addFiniteValues,
  createFiniteValueSample,
  robustColorRange,
} from "../app/color-range";
import type { VariableConfig } from "../app/data/types";

function variable(
  id: string,
  label: string,
  unit: string,
): VariableConfig {
  return {
    id,
    label,
    unit,
    dimensions: ["latitude", "longitude"],
    shape: [1, 1],
    chunkShape: [1, 1],
    dataType: "float32",
  };
}

const temperature = createFiniteValueSample();
addFiniteValues(
  temperature,
  [-10_000, ...Array.from({ length: 1_000 }, (_, index) => index), 10_000],
);
const temperatureRange = robustColorRange(
  temperature,
  variable("t2m", "2 metre temperature", "K"),
);
if (
  !temperatureRange
  || temperatureRange[0] <= -1_000
  || temperatureRange[1] >= 2_000
) {
  throw new Error(`Temperature outliers controlled the range: ${temperatureRange}`);
}

const precipitation = createFiniteValueSample();
addFiniteValues(precipitation, [
  ...Array.from({ length: 9_000 }, () => 0),
  ...Array.from({ length: 1_000 }, (_, index) => index + 1),
  100_000,
]);
const precipitationRange = robustColorRange(
  precipitation,
  variable("tp", "Total precipitation", "m"),
);
if (
  !precipitationRange
  || precipitationRange[0] !== 0
  || precipitationRange[1] >= 2_000
) {
  throw new Error(
    `The precipitation zero mass or right tail controlled the range: ${precipitationRange}`,
  );
}

const precipitationRate = createFiniteValueSample();
addFiniteValues(precipitationRate, [
  ...Array.from({ length: 9_000 }, () => 0.001),
  ...Array.from({ length: 900 }, () => 0.1),
  ...Array.from({ length: 90 }, () => 1),
  ...Array.from({ length: 10 }, () => 10),
]);
const precipitationRateRange = robustColorRange(
  precipitationRate,
  variable("tp", "Total precipitation", "kg m-2 s-1"),
  "mm/h",
);
if (
  !precipitationRateRange
  || precipitationRateRange[0] !== 0
  || precipitationRateRange[1] !== 5
) {
  throw new Error(
    `Numerical drizzle controlled the precipitation rate range: ${
      precipitationRateRange
    }`,
  );
}

const dryPrecipitation = createFiniteValueSample();
addFiniteValues(dryPrecipitation, [0, 0, 0]);
if (
  robustColorRange(
    dryPrecipitation,
    variable("tp", "Total precipitation", "m"),
  ) !== null
) {
  throw new Error("An all-dry frame should not replace the precipitation fallback");
}

const smoke = createFiniteValueSample();
addFiniteValues(smoke, [
  ...Array.from({ length: 9_000 }, () => 0),
  ...Array.from({ length: 1_000 }, (_, index) => (index + 1) * 1e-9),
  1,
]);
const smokeRange = robustColorRange(
  smoke,
  variable("mass_density_8m", "Mass density", "kg m-3"),
);
if (!smokeRange || smokeRange[0] !== 0 || smokeRange[1] >= 2e-6) {
  throw new Error(`Smoke zero mass or right tail controlled the range: ${smokeRange}`);
}

const direction = createFiniteValueSample();
addFiniteValues(direction, [45, 90, 180]);
const directionRange = robustColorRange(
  direction,
  variable("wind_direction_10m", "10 metre wind direction", "degrees"),
);
if (directionRange?.[0] !== 0 || directionRange[1] !== 360) {
  throw new Error(`Circular direction range was narrowed: ${directionRange}`);
}

const bounded = createFiniteValueSample(100);
addFiniteValues(
  bounded,
  Float32Array.from({ length: 1_000 }, (_, index) => index),
);
if (bounded.values.length !== 100 || bounded.seen !== 1_000) {
  throw new Error("Finite-value reservoir did not respect its sample bound");
}

console.log("Color range checks passed");
