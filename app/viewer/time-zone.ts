import timeZoneLookup from "@photostructure/tz-lookup";

type ZonedDateParts = {
  year: string;
  month: string;
  day: string;
  weekday: string;
  hour: string;
  minute: string;
  timeZoneName: string;
};

function zonedDateParts(date: Date, timeZone: string): ZonedDateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
    timeZoneName: "short",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    weekday: value("weekday"),
    hour: value("hour"),
    minute: value("minute"),
    timeZoneName: value("timeZoneName"),
  };
}

export function timeZoneAt(latitude: number, longitude: number) {
  if (
    !Number.isFinite(latitude)
    || !Number.isFinite(longitude)
    || latitude < -90
    || latitude > 90
    || longitude < -180
    || longitude > 180
  ) return "UTC";

  try {
    return timeZoneLookup(latitude, longitude);
  } catch {
    return "UTC";
  }
}

export function formatUtcTimeIndicator(date: Date) {
  const parts = zonedDateParts(date, "UTC");
  return `${parts.weekday}, ${parts.month} ${Number(parts.day)}, ${
    parts.hour
  }${parts.minute} UTC`;
}

export function formatLocalTimeIndicator(date: Date, timeZone: string) {
  const parts = zonedDateParts(date, timeZone);
  return `${parts.weekday}, ${parts.month} ${Number(parts.day)}, ${
    parts.hour
  }${parts.minute} ${parts.timeZoneName} · local`;
}

export function formatUtcTimestamp(date: Date) {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 13)}${iso.slice(14, 16)}Z`;
}

export function formatLocalTimestamp(date: Date, timeZone: string) {
  const parts = zonedDateParts(date, timeZone);
  const month = String(
    new Date(`${parts.month} 1, 2000 UTC`).getUTCMonth() + 1,
  ).padStart(2, "0");
  return `${parts.year}-${month}-${parts.day} ${parts.hour}${parts.minute} ${
    parts.timeZoneName
  } · local`;
}

export function formatUtcTick(date: Date, includeHour: boolean) {
  const month = date.toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  const day = date.getUTCDate();
  return includeHour
    ? `${month} ${day} ${String(date.getUTCHours()).padStart(2, "0")}${
      String(date.getUTCMinutes()).padStart(2, "0")
    }Z`
    : `${month} ${day}`;
}
