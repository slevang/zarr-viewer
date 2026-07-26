import {
  commonVariableMatches,
  type CommonVariableKey,
} from "./common-variables";
import type {
  DerivedVariableSpec,
  VariableConfig,
} from "./dataset";
import { unitConverter } from "./units";

type OperatorDefinition = {
  id: string;
  inputUnits: string[];
  outputUnit: string;
  evaluate: (first: number, second?: number, third?: number) => number;
};

type DerivedCatalogInput = {
  key: string;
  common: CommonVariableKey;
};

type DerivedCatalogDefinition = {
  key: string;
  label: string;
  standardName?: string;
  inputs: DerivedCatalogInput[];
  operator: string;
};

const KELVIN_OFFSET = 273.15;
const DEGREE_DAY_BASE_K = (65 - 32) * 5 / 9 + KELVIN_OFFSET;

function relativeHumidityFromDewPoint(
  temperatureK: number,
  dewPointK: number,
) {
  const temperatureC = temperatureK - KELVIN_OFFSET;
  const dewPointC = Math.min(dewPointK, temperatureK) - KELVIN_OFFSET;
  const humidity = 100 * Math.exp(
    17.625 * dewPointC / (243.04 + dewPointC)
    - 17.625 * temperatureC / (243.04 + temperatureC),
  );
  return Math.max(0, Math.min(100, humidity));
}

function heatIndexKelvin(temperatureK: number, dewPointK: number) {
  const temperatureF = (temperatureK - KELVIN_OFFSET) * 9 / 5 + 32;
  const humidity = relativeHumidityFromDewPoint(temperatureK, dewPointK);
  const simple = 0.5 * (
    temperatureF
    + 61
    + (temperatureF - 68) * 1.2
    + humidity * 0.094
  );
  const averaged = (simple + temperatureF) / 2;
  if (averaged < 80) return temperatureK;

  let heatIndex = (
    -42.379
    + 2.04901523 * temperatureF
    + 10.14333127 * humidity
    - 0.22475541 * temperatureF * humidity
    - 0.00683783 * temperatureF * temperatureF
    - 0.05481717 * humidity * humidity
    + 0.00122874 * temperatureF * temperatureF * humidity
    + 0.00085282 * temperatureF * humidity * humidity
    - 0.00000199 * temperatureF * temperatureF * humidity * humidity
  );
  if (humidity < 13 && temperatureF >= 80 && temperatureF <= 112) {
    heatIndex -= (
      (13 - humidity) / 4
      * Math.sqrt((17 - Math.abs(temperatureF - 95)) / 17)
    );
  } else if (humidity > 85 && temperatureF >= 80 && temperatureF <= 87) {
    heatIndex += (
      (humidity - 85) / 10
      * (87 - temperatureF) / 5
    );
  }
  return (heatIndex - 32) * 5 / 9 + KELVIN_OFFSET;
}

function windChillKelvin(temperatureK: number, windSpeedMps: number) {
  const temperatureC = temperatureK - KELVIN_OFFSET;
  const windSpeedKph = Math.max(0, windSpeedMps) * 3.6;
  if (temperatureC > 10 || windSpeedKph <= 4.8) return temperatureK;
  const windFactor = windSpeedKph ** 0.16;
  const windChillC = (
    13.12
    + 0.6215 * temperatureC
    - 11.37 * windFactor
    + 0.3965 * temperatureC * windFactor
  );
  return windChillC + KELVIN_OFFSET;
}

const OPERATORS: Record<string, OperatorDefinition> = Object.fromEntries(
  ([
    {
      id: "wind_speed",
      inputUnits: ["m/s", "m/s"],
      outputUnit: "m/s",
      evaluate: (u: number, v = NaN) => Math.hypot(u, v),
    },
    {
      id: "wind_direction",
      inputUnits: ["m/s", "m/s"],
      outputUnit: "degree",
      evaluate: (u: number, v = NaN) => Math.hypot(u, v) === 0
        ? NaN
        : (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360,
    },
    {
      id: "cooling_degree_days",
      inputUnits: ["tempK"],
      outputUnit: "degree_day_K",
      evaluate: (temperatureK: number) =>
        Math.max(0, temperatureK - DEGREE_DAY_BASE_K),
    },
    {
      id: "heating_degree_days",
      inputUnits: ["tempK"],
      outputUnit: "degree_day_K",
      evaluate: (temperatureK: number) =>
        Math.max(0, DEGREE_DAY_BASE_K - temperatureK),
    },
    {
      id: "heat_index",
      inputUnits: ["tempK", "tempK"],
      outputUnit: "tempK",
      evaluate: (temperatureK: number, dewPointK = NaN) =>
        heatIndexKelvin(temperatureK, dewPointK),
    },
    {
      id: "wind_chill",
      inputUnits: ["tempK", "m/s", "m/s"],
      outputUnit: "tempK",
      evaluate: (temperatureK: number, u = NaN, v = NaN) =>
        windChillKelvin(temperatureK, Math.hypot(u, v)),
    },
  ] satisfies OperatorDefinition[]).map(
    (definition) => [definition.id, definition],
  ),
);

const DERIVED_CATALOG: DerivedCatalogDefinition[] = [
  {
    key: "wind_speed_10m",
    label: "10 metre wind speed",
    standardName: "wind_speed",
    inputs: [
      { key: "u", common: "u10" },
      { key: "v", common: "v10" },
    ],
    operator: "wind_speed",
  },
  {
    key: "wind_direction_10m",
    label: "10 metre wind direction",
    standardName: "wind_from_direction",
    inputs: [
      { key: "u", common: "u10" },
      { key: "v", common: "v10" },
    ],
    operator: "wind_direction",
  },
  {
    key: "cdd_65f",
    label: "Cooling degree days (65°F base)",
    inputs: [{ key: "temperature", common: "t2m" }],
    operator: "cooling_degree_days",
  },
  {
    key: "hdd_65f",
    label: "Heating degree days (65°F base)",
    inputs: [{ key: "temperature", common: "t2m" }],
    operator: "heating_degree_days",
  },
  {
    key: "heat_index",
    label: "Heat index",
    standardName: "heat_index",
    inputs: [
      { key: "temperature", common: "t2m" },
      { key: "dew_point", common: "d2m" },
    ],
    operator: "heat_index",
  },
  {
    key: "wind_chill",
    label: "Wind chill",
    standardName: "wind_chill_of_air_temperature",
    inputs: [
      { key: "temperature", common: "t2m" },
      { key: "u", common: "u10" },
      { key: "v", common: "v10" },
    ],
    operator: "wind_chill",
  },
];

function arraysAlign(variables: VariableConfig[]) {
  const first = variables[0];
  return Boolean(first) && variables.every((variable) => (
    variable.dimensions.length === first.dimensions.length
    && variable.dimensions.every(
      (dimension, index) => dimension === first.dimensions[index],
    )
    && (
      !first.shape
      || !variable.shape
      || (
        variable.shape.length === first.shape.length
        && variable.shape.every((length, index) => length === first.shape?.[index])
      )
    )
  ));
}

function buildPipeline(
  definition: DerivedCatalogDefinition,
  inputs: Record<string, string>,
): DerivedVariableSpec {
  return {
    key: definition.key,
    inputs,
    transforms: [{
      id: "value",
      kind: "elementwise",
      operator: definition.operator,
      inputs: definition.inputs.map((input) => input.key),
    }],
    output: "value",
  };
}

export function derivedVariableMatches(
  nativeVariables: VariableConfig[],
): VariableConfig[] {
  const common = new Map(
    commonVariableMatches(nativeVariables).map(
      ({ key, variable }) => [key, variable],
    ),
  );
  return DERIVED_CATALOG.flatMap((definition) => {
    const inputs = definition.inputs.map((input) => common.get(input.common));
    if (
      inputs.some((input) => !input)
      || !arraysAlign(inputs as VariableConfig[])
    ) return [];
    const typedInputs = inputs as VariableConfig[];
    const operator = OPERATORS[definition.operator];
    const convertible = typedInputs.every(
      (input, index) => unitConverter(
        input.unit,
        operator.inputUnits[index],
      ) !== null,
    );
    if (!convertible) return [];
    const primary = typedInputs[0];
    const inputIds = Object.fromEntries(
      definition.inputs.map((input, index) => [
        input.key,
        typedInputs[index].id,
      ]),
    );
    return [{
      id: `derived__${definition.key}`,
      label: definition.label,
      unit: operator.outputUnit,
      standardName: definition.standardName,
      dimensions: [...primary.dimensions],
      shape: primary.shape ? [...primary.shape] : undefined,
      chunkShape: primary.innerChunkShape
        ? [...primary.innerChunkShape]
        : primary.chunkShape
          ? [...primary.chunkShape]
          : undefined,
      dataType: "float32",
      derived: buildPipeline(definition, inputIds),
    }];
  });
}

export function nativeInputsForDerived(
  variable: VariableConfig,
  nativeVariables: VariableConfig[],
) {
  if (!variable.derived) return [];
  return Object.entries(variable.derived.inputs).map(([key, variableId]) => {
    const input = nativeVariables.find((candidate) => candidate.id === variableId);
    if (!input) {
      throw new Error(
        `Derived variable ${variable.derived?.key} is missing input ${variableId}`,
      );
    }
    return { key, variable: input };
  });
}

export function executeDerivedPipeline(
  variable: VariableConfig,
  nativeVariables: VariableConfig[],
  inputValues: Record<string, ArrayLike<number | bigint>>,
) {
  const pipeline = variable.derived;
  if (!pipeline) throw new Error(`${variable.id} is not a derived variable`);
  const stages = new Map<string, { values: ArrayLike<number | bigint>; unit: string }>();
  for (const { key, variable: input } of nativeInputsForDerived(
    variable,
    nativeVariables,
  )) {
    const values = inputValues[key];
    if (!values) throw new Error(`Derived input ${key} was not loaded`);
    stages.set(key, { values, unit: input.unit });
  }

  for (const transform of pipeline.transforms) {
    if (transform.kind !== "elementwise") {
      throw new Error(`Unsupported derived transform ${transform.kind}`);
    }
    const operator = OPERATORS[transform.operator];
    if (!operator) throw new Error(`Unknown derived operator ${transform.operator}`);
    const inputs = transform.inputs.map((input, index) => {
      const stage = stages.get(input);
      if (!stage) throw new Error(`Derived stage ${transform.id} is missing ${input}`);
      const convert = unitConverter(stage.unit, operator.inputUnits[index]);
      if (!convert) {
        throw new Error(
          `Cannot convert derived input ${input} from ${stage.unit}`
          + ` to ${operator.inputUnits[index]}`,
        );
      }
      return { ...stage, convert };
    });
    const length = inputs[0]?.values.length ?? 0;
    if (inputs.some((input) => input.values.length !== length)) {
      throw new Error(`Derived stage ${transform.id} received misaligned inputs`);
    }
    const output = new Float32Array(length);
    for (let index = 0; index < length; index += 1) {
      const first = inputs[0]?.convert(Number(inputs[0].values[index])) ?? NaN;
      const second = inputs[1]?.convert(Number(inputs[1].values[index]));
      const third = inputs[2]?.convert(Number(inputs[2].values[index]));
      output[index] = (
        Number.isFinite(first)
        && (second === undefined || Number.isFinite(second))
        && (third === undefined || Number.isFinite(third))
      )
        ? operator.evaluate(first, second, third)
        : NaN;
    }
    stages.set(transform.id, {
      values: output,
      unit: operator.outputUnit,
    });
  }

  const result = stages.get(pipeline.output);
  if (!result) throw new Error(`Derived pipeline has no output ${pipeline.output}`);
  return { values: result.values as Float32Array, unit: result.unit };
}

export function derivedDisplayId(variable: VariableConfig) {
  return variable.derived?.key ?? variable.id;
}
