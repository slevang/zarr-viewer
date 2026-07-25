import { registry } from "zarrita";

type GribberishConfig = {
  var?: string;
  adjust_longitude_range?: boolean;
  north_up?: boolean;
};

type ChunkMeta = {
  dataType: string;
  shape: number[];
};

type NumericArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | BigInt64Array
  | BigUint64Array;

function cStrides(shape: number[]) {
  const strides = new Array<number>(shape.length);
  let stride = 1;
  for (let index = shape.length - 1; index >= 0; index -= 1) {
    strides[index] = stride;
    stride *= shape[index];
  }
  return strides;
}

function castValues(values: number[], dataType: string): NumericArray {
  switch (dataType) {
    case "float32": return Float32Array.from(values);
    case "float64": return Float64Array.from(values);
    case "int8": return Int8Array.from(values);
    case "uint8": return Uint8Array.from(values);
    case "int16": return Int16Array.from(values);
    case "uint16": return Uint16Array.from(values);
    case "int32": return Int32Array.from(values);
    case "uint32": return Uint32Array.from(values);
    case "int64": return BigInt64Array.from(values, BigInt);
    case "uint64": return BigUint64Array.from(values, BigInt);
    default: throw new Error(`Gribberish does not support ${dataType} output`);
  }
}

const codecLoader = async () => ({
  kind: "array_to_bytes" as const,
  fromConfig(configValue: unknown, meta: ChunkMeta) {
    const config = (configValue ?? {}) as GribberishConfig;
    return {
      kind: "array_to_bytes" as const,
      encode(): never {
        throw new Error("The Gribberish browser codec is read-only");
      },
      async decode(bytes: Uint8Array) {
        if (
          typeof window !== "undefined"
          && (typeof SharedArrayBuffer === "undefined" || !window.crossOriginIsolated)
        ) {
          throw new Error(
            "Virtual HRRR requires cross-origin-isolated hosting for the Gribberish WASM decoder",
          );
        }
        const { GribMessage } = await import("@mattnucc/gribberish");
        const message = GribMessage.parseFromBuffer(bytes, 0);
        const adjustLongitude = Boolean(config.adjust_longitude_range);
        const northUp = Boolean(config.north_up);
        let values: number[];

        if (config.var === "latitude" || config.var === "longitude") {
          const coordinates = message.latlngAdjusted(adjustLongitude, northUp);
          values = config.var === "latitude"
            ? coordinates.latitude
            : coordinates.longitude;
        } else {
          values = message.dataAdjusted(adjustLongitude, northUp);
        }

        const expected = meta.shape.reduce((size, value) => size * value, 1);
        if (values.length !== expected) {
          throw new Error(
            `Gribberish decoded ${values.length} values; expected ${expected}`,
          );
        }

        return {
          data: castValues(values, meta.dataType),
          shape: [...meta.shape],
          stride: cStrides(meta.shape),
        };
      },
    };
  },
});

let registered = false;

export function registerGribberishCodec() {
  if (registered) return;
  // Zarrita's public registry type is narrowed to numcodecs' bytes codec
  // signature even though its runtime also accepts array-to-bytes codecs.
  registry.set("gribberish", codecLoader as never);
  registered = true;
}
