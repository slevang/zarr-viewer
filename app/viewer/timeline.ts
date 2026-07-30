const DAY_MS = 24 * 60 * 60 * 1000;

export const FORECAST_WINDOW_DAYS = 7;

export function timelineRangeDays(start: number, stop: number) {
  if (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) {
    return 1;
  }
  return Math.max(1, Math.ceil((stop - start) / DAY_MS));
}

export function timelineWidthPercent(
  start: number,
  stop: number,
  visibleDays = FORECAST_WINDOW_DAYS,
) {
  if (
    !Number.isFinite(start)
    || !Number.isFinite(stop)
    || stop <= start
    || !Number.isFinite(visibleDays)
    || visibleDays <= 0
  ) return 100;
  return Math.max(100, (stop - start) / (visibleDays * DAY_MS) * 100);
}
