import {
  DATASETS,
  DEFAULT_DATASET_ID,
  getDataset,
  hasMapSource,
} from "../catalog";

const DATASET_PARAMETER = "dataset";
const UNIT_PREFERENCES_STORAGE_KEY = "zarr-viewer:unit-preferences";
const MAP_DATASETS = DATASETS.filter(hasMapSource);

export function initialDatasetId() {
  if (typeof window === "undefined") return getDataset(DEFAULT_DATASET_ID).id;
  const requested = new URL(window.location.href).searchParams.get(
    DATASET_PARAMETER,
  );
  return requested && MAP_DATASETS.some((candidate) => candidate.id === requested)
    ? requested
    : getDataset(DEFAULT_DATASET_ID).id;
}

export function storedUnitPreferences() {
  if (typeof window === "undefined") return {};
  try {
    const value = window.localStorage.getItem(UNIT_PREFERENCES_STORAGE_KEY);
    if (!value) return {};
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

export function storeUnitPreferences(preferences: Record<string, string>) {
  try {
    window.localStorage.setItem(
      UNIT_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences),
    );
  } catch {
    // Unit selection still works for the current session without storage.
  }
}
