import type { DatasetConfig, DatasetSourceConfig } from "../catalog";
import { axisValueAsDate, timedeltaMilliseconds } from "../data/axes";
import { isSpatialDimension } from "../data/dimensions";
import type { AxisConfig, AxisSelection, VariableConfig } from "../data/types";

export type PlaybackPrefetchQueue = {
  generation: number;
  axisId: string;
  ahead: number;
  behind: number;
  concurrency: number;
  directChunkReads: boolean;
  rampUp: boolean;
  controller: AbortController;
  ready: Set<number>;
  promises: Map<number, Promise<void>>;
  resolve: Map<number, () => void>;
  queued: number[];
  queuedSet: Set<number>;
  inFlight: Set<number>;
  attempts: Map<number, number>;
};

const PLAYBACK_DATA_HOURS_PER_SECOND = 6;
const PLAYBACK_FALLBACK_INTERVAL_MS = 250;
const PLAYBACK_PREFETCH_BASE_AHEAD = 10;
const PLAYBACK_PREFETCH_BASE_BEHIND = 3;
const PLAYBACK_PREFETCH_FALLBACK_CONCURRENCY = 2;
const PLAYBACK_PREFETCH_MAX_CONCURRENCY = 32;
const PLAYBACK_PREFETCH_MEMORY_BUDGET_BYTES = 1024 * 1024 * 1024;

export function playbackInterval(
  dataset: DatasetConfig,
  axis: AxisConfig,
  currentIndex: number,
  nextIndex: number,
) {
  let stepMilliseconds = NaN;
  if (axis.kind === "time") {
    stepMilliseconds = Math.abs(
      axisValueAsDate(dataset, axis, nextIndex).getTime()
      - axisValueAsDate(dataset, axis, currentIndex).getTime(),
    );
  } else if (axis.kind === "timedelta") {
    stepMilliseconds = Math.abs(
      timedeltaMilliseconds(axis, nextIndex)
      - timedeltaMilliseconds(axis, currentIndex),
    );
  }
  if (!Number.isFinite(stepMilliseconds) || stepMilliseconds <= 0) {
    return PLAYBACK_FALLBACK_INTERVAL_MS;
  }
  const dataHours = stepMilliseconds / 3_600_000;
  return Math.max(
    100,
    Math.min(4_000, (dataHours / PLAYBACK_DATA_HOURS_PER_SECOND) * 1_000),
  );
}

function dataTypeByteWidth(dataType?: string) {
  const normalized = dataType?.toLowerCase() ?? "";
  if (normalized.includes("64") || /[fiu]8$/.test(normalized)) return 8;
  if (normalized.includes("16") || /[fiu]2$/.test(normalized)) return 2;
  if (normalized.includes("8") || /[iu]1$/.test(normalized)) return 1;
  return 4;
}

export function playbackPrefetchProfile(
  source: DatasetSourceConfig,
  variable: VariableConfig,
  axis: AxisConfig,
) {
  const axisIndex = variable.dimensions.indexOf(axis.id);
  const { shape, chunkShape } = variable;
  if (
    axisIndex < 0
    || !chunkShape
    || chunkShape.length !== variable.dimensions.length
  ) {
    return {
      ahead: PLAYBACK_PREFETCH_BASE_AHEAD,
      behind: PLAYBACK_PREFETCH_BASE_BEHIND,
      concurrency: PLAYBACK_PREFETCH_FALLBACK_CONCURRENCY,
      directChunkReads: false,
    };
  }

  const axisChunkLength = Math.max(1, Math.floor(chunkShape[axisIndex] ?? 1));
  const decodedChunkBytes = chunkShape.reduce(
    (total, length) => total * Math.max(1, length),
    dataTypeByteWidth(variable.dataType),
  );
  const memoryFrameCap = Math.max(
    1,
    Math.floor(PLAYBACK_PREFETCH_MEMORY_BUDGET_BYTES / decodedChunkBytes),
  );

  let spatialChunksPerFrame = 1;
  if (shape?.length === chunkShape.length) {
    variable.dimensions.forEach((dimension, index) => {
      if (isSpatialDimension(dimension, source)) {
        spatialChunksPerFrame *= Math.ceil(
          Math.max(1, shape[index] ?? 1) / Math.max(1, chunkShape[index] ?? 1),
        );
      }
    });
  }
  const spatialCap = spatialChunksPerFrame <= 1
    ? PLAYBACK_PREFETCH_MAX_CONCURRENCY
    : spatialChunksPerFrame <= 4
      ? 6
      : spatialChunksPerFrame <= 16
        ? 3
        : 2;
  const directChunkReads = (
    !variable.derived
    && source.directChunkReads === true
    && spatialChunksPerFrame === 1
  );
  const ahead = Math.min(PLAYBACK_PREFETCH_BASE_AHEAD, memoryFrameCap);
  const temporalChunkCount = Math.max(
    1,
    Math.ceil(ahead / axisChunkLength),
  );
  const temporalCap = axisChunkLength >= 10
    ? 1
    : temporalChunkCount;

  return {
    ahead,
    behind: Math.min(PLAYBACK_PREFETCH_BASE_BEHIND, memoryFrameCap),
    concurrency: Math.max(
      1,
      Math.min(
        PLAYBACK_PREFETCH_MAX_CONCURRENCY,
        temporalCap,
        spatialCap,
      ),
    ),
    directChunkReads,
  };
}

export function playbackChunkKey(
  variable: VariableConfig,
  selections: AxisSelection,
): `/${string}` | undefined {
  const { shape, chunkShape } = variable;
  if (
    !shape
    || !chunkShape
    || shape.length !== variable.dimensions.length
    || chunkShape.length !== variable.dimensions.length
  ) return undefined;
  const chunkCoordinates = variable.dimensions.map((dimension, index) => {
    if (isSpatialDimension(dimension)) {
      if ((shape[index] ?? 1) > (chunkShape[index] ?? 1)) return NaN;
      return 0;
    }
    return Math.floor(
      (selections[dimension] ?? 0) / Math.max(1, chunkShape[index] ?? 1),
    );
  });
  if (chunkCoordinates.some((value) => !Number.isFinite(value))) return undefined;
  return `/${variable.id}/c/${chunkCoordinates.join("/")}`;
}
