import type { TransformRequest } from "@carbonplan/zarr-layer";
import type { Readable } from "zarrita";
import type {
  DatasetConfig,
  DatasetSourceConfig,
  DatasetSourceRole,
} from "../catalog";

export type AxisKind = "time" | "timedelta" | "number" | "category";

export type AxisConfig = {
  id: string;
  label: string;
  unit: string;
  kind: AxisKind;
  values: Array<number | string>;
  defaultIndex?: number;
  requiresStoreReload?: boolean;
};

export type DerivedTransformConfig = {
  id: string;
  kind: "elementwise";
  operator: string;
  inputs: string[];
};

export type DerivedVariableSpec = {
  key: string;
  inputs: Record<string, string>;
  transforms: DerivedTransformConfig[];
  output: string;
};

export type VariableConfig = {
  id: string;
  label: string;
  unit: string;
  standardName?: string;
  dimensions: string[];
  shape?: number[];
  chunkShape?: number[];
  innerChunkShape?: number[];
  dataType?: string;
  derived?: DerivedVariableSpec;
};

export type StoreInfo = {
  dataset: DatasetConfig;
  source: DatasetSourceConfig;
  role: DatasetSourceRole;
  variables: VariableConfig[];
  derivedVariables?: VariableConfig[];
  axes: Record<string, AxisConfig>;
  store?: Readable;
  layerOptions: {
    source?: string;
    store?: Readable;
    zarrVersion: 2 | 3;
    crs: string;
    bounds?: [number, number, number, number];
    latIsAscending?: boolean;
    spatialDimensions?: { lat: string; lon: string };
    proj4?: string;
    transformRequest?: TransformRequest;
  };
};

export type AxisSelection = Record<string, number>;

export type PointTimeSeries = {
  kind: "history";
  values: number[];
  dates: Date[];
  unit: string;
  variableLabel: string;
  latitude: number;
  longitude: number;
};

export type ForecastQuantiles = {
  min: number;
  q10: number;
  q25: number;
  q50: number;
  q75: number;
  q90: number;
  max: number;
};

export type PointForecastSeries = {
  kind: "forecast";
  quantiles: ForecastQuantiles[];
  dates: Date[];
  unit: string;
  variableLabel: string;
  latitude: number;
  longitude: number;
  memberCount: number;
};

export type PointSeries = PointTimeSeries | PointForecastSeries;

export type PointSeriesLoadOptions = {
  signal?: AbortSignal;
  concurrency?: number;
};
