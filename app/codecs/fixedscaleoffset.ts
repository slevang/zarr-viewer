import { registry } from "zarrita";

type NumericChunk = {
  data: Float32Array | Float64Array;
  shape: number[];
  stride: number[];
};

type CodecConfig = {
  scale?: number;
  offset?: number;
};

type ChunkMeta = {
  dataType: string;
};

const codecLoader = async () => ({
  kind: "array_to_array" as const,
  fromConfig(config: CodecConfig, meta: ChunkMeta) {
    if (meta.dataType !== "float32" && meta.dataType !== "float64") {
      throw new Error(
        `FixedScaleOffset browser adapter does not support ${meta.dataType}`,
      );
    }
    const scale = config.scale ?? 1;
    const offset = config.offset ?? 0;
    const ArrayType = meta.dataType === "float32" ? Float32Array : Float64Array;
    return {
      kind: "array_to_array" as const,
      encode(): never {
        throw new Error("The FixedScaleOffset browser adapter is read-only");
      },
      decode(chunk: NumericChunk) {
        const data = new ArrayType(chunk.data.length);
        for (let index = 0; index < chunk.data.length; index += 1) {
          data[index] = chunk.data[index] / scale + offset;
        }
        return {
          data,
          shape: chunk.shape,
          stride: chunk.stride,
        };
      },
    };
  },
});

let registered = false;

export function registerFixedScaleOffset() {
  if (registered) return;
  registry.set("numcodecs.fixedscaleoffset", codecLoader as never);
  registry.set("fixedscaleoffset", codecLoader as never);
  registered = true;
}
