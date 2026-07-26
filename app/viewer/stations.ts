import type { AsosStation } from "../asos-types";

export type StationFeatureLike = {
  geometry: {
    type: string;
    coordinates?: unknown;
  };
  properties?: Record<string, unknown> | null;
};

export function shortCoordinate(value: number, positive: string, negative: string) {
  return `${Math.abs(value).toFixed(2)}°${value >= 0 ? positive : negative}`;
}

export function stationFromFeature(
  feature: StationFeatureLike,
): AsosStation | null {
  const coordinates = feature.geometry.type === "Point"
    && Array.isArray(feature.geometry.coordinates)
    ? feature.geometry.coordinates
    : null;
  if (!coordinates) return null;
  const longitude = Number(coordinates[0]);
  const latitude = Number(coordinates[1]);
  const properties = feature.properties ?? {};
  const station = String(properties.station ?? "");
  if (
    !station
    || !Number.isFinite(longitude)
    || !Number.isFinite(latitude)
  ) return null;
  return {
    station,
    name: String(properties.name ?? station),
    state: String(properties.state ?? ""),
    country: String(properties.country ?? ""),
    elevation: Number(properties.elevation),
    longitude,
    latitude,
  };
}

export function formatAsosTime(date: Date) {
  return `${date.toISOString().slice(0, 16).replace("T", " ")}Z`;
}
