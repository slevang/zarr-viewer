import { registry } from "zarrita";
import init, {
  decompress_f32,
  decompress_f64,
} from "../../packages/zarrita-pcodec/pkg/pcodec_wasm.js";

type ChunkMeta = {
  dataType: string;
  shape: number[];
};

let wasmReady: Promise<unknown> | undefined;

export function initializePcodec(
  input?: BufferSource | WebAssembly.Module,
) {
  wasmReady ??= input === undefined
    ? init()
    : init({ module_or_path: input });
  return wasmReady;
}

function cStrides(shape: number[]) {
  const strides = new Array<number>(shape.length);
  let stride = 1;
  for (let index = shape.length - 1; index >= 0; index -= 1) {
    strides[index] = stride;
    stride *= shape[index];
  }
  return strides;
}

const codecLoader = async () => ({
  kind: "array_to_bytes" as const,
  fromConfig(_config: unknown, meta: ChunkMeta) {
    if (meta.dataType !== "float32" && meta.dataType !== "float64") {
      throw new Error(`PCodec WASM does not yet support ${meta.dataType}`);
    }
    return {
      kind: "array_to_bytes" as const,
      encode(): never {
        throw new Error("The PCodec browser adapter is read-only");
      },
      async decode(bytes: Uint8Array) {
        await initializePcodec();
        const data = meta.dataType === "float32"
          ? decompress_f32(bytes)
          : decompress_f64(bytes);
        const expected = meta.shape.reduce((size, value) => size * value, 1);
        if (data.length !== expected) {
          throw new Error(`PCodec decoded ${data.length} values; expected ${expected}`);
        }
        return {
          data,
          shape: [...meta.shape],
          stride: cStrides(meta.shape),
        };
      },
    };
  },
});

let registered = false;

export function registerPcodec() {
  if (registered) return;
  registry.set("numcodecs.pcodec", codecLoader as never);
  registry.set("pcodec", codecLoader as never);
  registered = true;
}
