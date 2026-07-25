import type { PointTimeSeries } from "./dataset";

export const ASOS_SERIES_ID = "asos-observations";
export const ASOS_SERIES_COLOR = "#ff5f57";
export const ASOS_MANIFEST_URL = `${import.meta.env.BASE_URL}asos-stations.geojson`;

export const ASOS_NEAREST_TOLERANCE_MS = 90 * 60 * 1000;

export type AsosStation = {
  station: string;
  name: string;
  state: string;
  country: string;
  elevation: number;
  longitude: number;
  latitude: number;
};

export type AsosRecord = {
  valid: Date;
  tmpc: number | null;
  dwpc: number | null;
  relh: number | null;
  drct: number | null;
  sknt: number | null;
  gust: number | null;
  mslp: number | null;
  vsby: number | null;
  p01m: number | null;
};

export type AsosWindow = {
  series: PointTimeSeries | null;
  records: AsosRecord[];
  unit: string | null;
  message: string;
};

export function asosAtTime(window: AsosWindow | null, cursorDate?: Date) {
  if (!window || !cursorDate) return { record: null, value: null };
  const cursor = cursorDate.getTime();
  const record = window.records.reduce<AsosRecord | null>((best, candidate) => (
    !best
    || Math.abs(candidate.valid.getTime() - cursor)
      < Math.abs(best.valid.getTime() - cursor)
      ? candidate
      : best
  ), null);
  const nearestRecord = (
    record
    && Math.abs(record.valid.getTime() - cursor) <= ASOS_NEAREST_TOLERANCE_MS
  ) ? record : null;
  if (!window.series) return { record: nearestRecord, value: null };

  let value: number | null = null;
  let distance = Number.POSITIVE_INFINITY;
  window.series.dates.forEach((date, index) => {
    const nextDistance = Math.abs(date.getTime() - cursor);
    if (nextDistance <= ASOS_NEAREST_TOLERANCE_MS && nextDistance < distance) {
      distance = nextDistance;
      value = window.series?.values[index] ?? null;
    }
  });
  return { record: nearestRecord, value };
}
