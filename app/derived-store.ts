import * as zarr from "zarrita";
import type {
  AbsolutePath,
  GetOptions,
  RangeQuery,
  Readable,
} from "zarrita";
import type {
  StoreInfo,
  VariableConfig,
} from "./data/types";
import {
  executeDerivedPipeline,
  nativeInputsForDerived,
} from "./derived-variables";
const DERIVED_CHUNK_CACHE_BYTES = 512 * 1024 * 1024;
const textEncoder = new TextEncoder();
const storeCache = new WeakMap<
  StoreInfo,
  Map<string, Promise<Readable>>
>();

type ZarrResult = {
  data: ArrayLike<number | bigint>;
  shape: number[];
  stride: number[];
};

function product(shape: number[]) {
  return shape.reduce((total, length) => total * length, 1);
}

function cStride(shape: number[]) {
  const stride = new Array<number>(shape.length);
  let current = 1;
  for (let index = shape.length - 1; index >= 0; index -= 1) {
    stride[index] = current;
    current *= shape[index];
  }
  return stride;
}

function contiguousValues(result: ZarrResult) {
  const expectedStride = cStride(result.shape);
  if (
    expectedStride.length === result.stride.length
    && expectedStride.every((value, index) => value === result.stride[index])
  ) return result.data;

  const values = new Float64Array(product(result.shape));
  for (let linear = 0; linear < values.length; linear += 1) {
    let remainder = linear;
    let sourceIndex = 0;
    for (let dimension = result.shape.length - 1; dimension >= 0; dimension -= 1) {
      const coordinate = remainder % result.shape[dimension];
      remainder = Math.floor(remainder / result.shape[dimension]);
      sourceIndex += coordinate * result.stride[dimension];
    }
    values[linear] = Number(result.data[sourceIndex]);
  }
  return values;
}

function bytesOf(values: Float32Array | Float64Array) {
  return new Uint8Array(
    values.buffer.slice(
      values.byteOffset,
      values.byteOffset + values.byteLength,
    ),
  );
}

function padChunk(
  values: Float32Array,
  actualShape: number[],
  chunkShape: number[],
) {
  if (
    actualShape.length === chunkShape.length
    && actualShape.every((length, index) => length === chunkShape[index])
  ) return values;
  const padded = new Float32Array(product(chunkShape));
  padded.fill(NaN);
  const targetStride = cStride(chunkShape);
  for (let sourceIndex = 0; sourceIndex < values.length; sourceIndex += 1) {
    let remainder = sourceIndex;
    let targetIndex = 0;
    for (let dimension = actualShape.length - 1; dimension >= 0; dimension -= 1) {
      const coordinate = remainder % actualShape[dimension];
      remainder = Math.floor(remainder / actualShape[dimension]);
      targetIndex += coordinate * targetStride[dimension];
    }
    padded[targetIndex] = values[sourceIndex];
  }
  return padded;
}

function arrayMetadata(
  shape: number[],
  chunks: number[],
  dimensions: string[],
  dataType: "float32" | "float64",
  attributes: Record<string, unknown> = {},
) {
  return {
    shape,
    data_type: dataType,
    chunk_grid: {
      name: "regular",
      configuration: { chunk_shape: chunks },
    },
    chunk_key_encoding: {
      name: "default",
      configuration: { separator: "/" },
    },
    fill_value: "NaN",
    codecs: [{
      name: "bytes",
      configuration: { endian: "little" },
    }],
    attributes,
    dimension_names: dimensions,
    zarr_format: 3,
    node_type: "array",
    storage_transformers: [],
  };
}

async function coordinateValues(
  info: StoreInfo,
  dimension: string,
  length: number,
) {
  const configured = info.axes[dimension]?.values;
  if (
    configured?.length === length
    && configured.every((value) => Number.isFinite(Number(value)))
  ) {
    return Float64Array.from(configured, Number);
  }
  if (info.store && length <= 2_000_000) {
    try {
      const coordinate = await zarr.open(
        zarr.root(info.store).resolve(dimension),
        { kind: "array" },
      );
      const result = await zarr.get(coordinate);
      if (result.data.length === length) {
        return Float64Array.from(
          result.data as ArrayLike<number | bigint>,
          Number,
        );
      }
    } catch {
      // Explicit map bounds remain available when a coordinate is not stored.
    }
  }
  return Float64Array.from({ length }, (_, index) => index);
}

function createVirtualStore(
  staticBytes: Map<string, Uint8Array>,
  readChunk: (
    key: string,
    options?: GetOptions,
  ) => Promise<Uint8Array | undefined>,
): Readable {
  const completed = new Map<string, Uint8Array>();
  const pending = new Map<string, Promise<Uint8Array | undefined>>();
  let cachedBytes = 0;
  const remember = (key: string, value: Uint8Array) => {
    const existing = completed.get(key);
    if (existing) cachedBytes -= existing.byteLength;
    completed.delete(key);
    completed.set(key, value);
    cachedBytes += value.byteLength;
    while (cachedBytes > DERIVED_CHUNK_CACHE_BYTES && completed.size > 1) {
      const oldest = completed.keys().next().value as string | undefined;
      if (!oldest) break;
      const removed = completed.get(oldest);
      completed.delete(oldest);
      cachedBytes -= removed?.byteLength ?? 0;
    }
  };

  const store: Readable = {
    async get(key, options) {
      const normalized = `/${String(key).replace(/^\/+/, "")}` as AbsolutePath;
      const fixed = staticBytes.get(normalized);
      if (fixed) return fixed;
      const cached = completed.get(normalized);
      if (cached) {
        completed.delete(normalized);
        completed.set(normalized, cached);
        return cached;
      }
      const inFlight = pending.get(normalized);
      if (inFlight) return inFlight;
      const task = readChunk(normalized, options).then((value) => {
        if (value) remember(normalized, value);
        return value;
      }).finally(() => pending.delete(normalized));
      pending.set(normalized, task);
      return task;
    },
    async getRange(key, query: RangeQuery, options) {
      const bytes = await store.get(key, options);
      if (!bytes) return undefined;
      if ("suffixLength" in query) {
        return bytes.slice(Math.max(0, bytes.length - query.suffixLength));
      }
      return bytes.slice(query.offset, query.offset + query.length);
    },
  };
  return store;
}

async function buildDerivedStore(
  info: StoreInfo,
  variable: VariableConfig,
): Promise<Readable> {
  if (!info.store || !variable.derived || !variable.shape) {
    throw new Error(`Derived map data is unavailable for ${variable.id}`);
  }
  const chunks = variable.chunkShape;
  if (!chunks || chunks.length !== variable.shape.length) {
    throw new Error(`Derived variable ${variable.id} has no compatible chunk grid`);
  }
  const nativeInputs = nativeInputsForDerived(variable, info.variables);
  const arrays = await Promise.all(nativeInputs.map(async ({ key, variable: input }) => ({
    key,
    variable: input,
    array: await zarr.open(
      zarr.root(info.store!).resolve(input.id),
      { kind: "array" },
    ),
  })));
  const coordinateEntries = await Promise.all(
    variable.dimensions.map(async (dimension, index) => {
      const values = await coordinateValues(
        info,
        dimension,
        variable.shape?.[index] ?? 0,
      );
      return { dimension, values };
    }),
  );

  const metadata: Record<string, unknown> = {
    [variable.id]: arrayMetadata(
      variable.shape,
      chunks,
      variable.dimensions,
      "float32",
      {
        long_name: variable.label,
        units: variable.unit,
        standard_name: variable.standardName,
        derived_pipeline: variable.derived,
      },
    ),
  };
  const staticBytes = new Map<string, Uint8Array>();
  for (const { dimension, values } of coordinateEntries) {
    metadata[dimension] = arrayMetadata(
      [values.length],
      [Math.max(1, values.length)],
      [dimension],
      "float64",
    );
    staticBytes.set(`/${dimension}/c/0`, bytesOf(values));
  }
  const rootMetadata = {
    attributes: {
      derived_variable: variable.derived.key,
    },
    zarr_format: 3,
    consolidated_metadata: {
      kind: "inline",
      must_understand: false,
      metadata,
    },
    node_type: "group",
  };
  staticBytes.set(
    "/zarr.json",
    textEncoder.encode(JSON.stringify(rootMetadata)),
  );
  for (const [id, entry] of Object.entries(metadata)) {
    staticBytes.set(
      `/${id}/zarr.json`,
      textEncoder.encode(JSON.stringify(entry)),
    );
  }

  const readDerivedChunk = async (
    key: string,
    options?: GetOptions,
  ): Promise<Uint8Array | undefined> => {
    const prefix = `/${variable.id}/c/`;
    if (!key.startsWith(prefix)) return undefined;
    const coordinates = key.slice(prefix.length).split("/").map(Number);
    if (
      coordinates.length !== variable.shape?.length
      || coordinates.some((value) => !Number.isInteger(value) || value < 0)
    ) return undefined;
    const starts = coordinates.map(
      (coordinate, index) => coordinate * chunks[index],
    );
    if (starts.some((start, index) => start >= (variable.shape?.[index] ?? 0))) {
      return undefined;
    }
    const stops = starts.map(
      (start, index) => Math.min(
        start + chunks[index],
        variable.shape?.[index] ?? 0,
      ),
    );
    const selectors = starts.map(
      (start, index) => zarr.slice(start, stops[index]),
    );
    const results = await Promise.all(arrays.map(
      ({ array }) => zarr.get(
        array,
        selectors,
        { signal: options?.signal },
      ),
    ));
    const inputValues = Object.fromEntries(
      results.map((result, index) => [
        arrays[index].key,
        contiguousValues(result as ZarrResult),
      ]),
    );
    const derived = executeDerivedPipeline(
      variable,
      info.variables,
      inputValues,
    );
    return bytesOf(padChunk(
      derived.values,
      stops.map((stop, index) => stop - starts[index]),
      chunks,
    ));
  };

  return createVirtualStore(staticBytes, readDerivedChunk);
}

export function derivedLayerOptions(
  info: StoreInfo,
  variable: VariableConfig,
): Promise<StoreInfo["layerOptions"]> {
  if (!variable.derived) return Promise.resolve(info.layerOptions);
  let byVariable = storeCache.get(info);
  if (!byVariable) {
    byVariable = new Map();
    storeCache.set(info, byVariable);
  }
  let store = byVariable.get(variable.id);
  if (!store) {
    store = buildDerivedStore(info, variable);
    byVariable.set(variable.id, store);
  }
  return store.then((derivedStore) => ({
    ...info.layerOptions,
    source: undefined,
    store: derivedStore,
    zarrVersion: 3,
    transformRequest: undefined,
  }));
}
