import type {
  DatasetConfig,
  DatasetSourceRole,
} from "../catalog";

export type DatasetPreloadRequest = {
  datasetId: string;
  role: DatasetSourceRole;
  targetDate?: Date;
};

type DatasetPreloadOptions = {
  activeDatasetId: string;
  targetDate?: Date;
  activeDatasetTargetDate?: Date;
  includeAuthenticated?: boolean;
  availableAuth?: ReadonlyArray<
    NonNullable<DatasetConfig["sources"]["map"]>["auth"]
  >;
};

function canPreload(
  dataset: DatasetConfig,
  role: DatasetSourceRole,
  includeAuthenticated: boolean,
  availableAuth: DatasetPreloadOptions["availableAuth"],
) {
  const source = dataset.sources[role];
  return source && (
    includeAuthenticated
    || !source.auth
    || availableAuth?.includes(source.auth)
  );
}

export function datasetPreloadRequests(
  datasets: DatasetConfig[],
  {
    activeDatasetId,
    targetDate,
    activeDatasetTargetDate,
    includeAuthenticated = false,
    availableAuth = [],
  }: DatasetPreloadOptions,
) {
  const requests: DatasetPreloadRequest[] = [];

  // Point-series stores come first because they are opened interactively after
  // a map click and can be substantially slower than a consolidated Zarr root.
  for (const dataset of datasets) {
    if (!canPreload(dataset, "series", includeAuthenticated, availableAuth)) {
      continue;
    }
    requests.push({
      datasetId: dataset.id,
      role: "series",
      targetDate: dataset.id === activeDatasetId
        ? activeDatasetTargetDate ?? targetDate
        : targetDate,
    });
  }

  for (const dataset of datasets) {
    if (
      dataset.id === activeDatasetId
      || !canPreload(dataset, "map", includeAuthenticated, availableAuth)
    ) continue;
    requests.push({
      datasetId: dataset.id,
      role: "map",
      targetDate,
    });
  }

  return requests;
}

export async function runDatasetPreloads(
  requests: DatasetPreloadRequest[],
  load: (request: DatasetPreloadRequest) => Promise<unknown>,
  concurrency = 1,
) {
  const failures: Array<{
    request: DatasetPreloadRequest;
    error: unknown;
  }> = [];
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < requests.length) {
      const request = requests[nextIndex];
      nextIndex += 1;
      try {
        await load(request);
      } catch (error) {
        failures.push({ request, error });
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, Math.floor(concurrency)), requests.length) },
      worker,
    ),
  );
  return failures;
}
