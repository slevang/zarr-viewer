import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Meteogram } from "../app/Meteogram";

const date = new Date("2026-07-20T00:00:00Z");
const markup = renderToStaticMarkup(createElement(Meteogram, {
  entries: [],
  fields: {
    precipitationRate: {
      kind: "history",
      dates: [date],
      values: [1.2],
      unit: "mm/h",
      variableLabel: "Precipitation rate",
      latitude: 42,
      longitude: -71,
    },
    windSpeed: {
      kind: "history",
      dates: [date],
      values: [10],
      unit: "m/s",
      variableLabel: "Wind speed",
      latitude: 42,
      longitude: -71,
    },
    windSpeedDistribution: {
      kind: "forecast",
      dates: [date],
      quantiles: [{
        min: 12,
        q10: 12,
        q25: 13,
        q50: 14,
        q75: 15,
        q90: 16,
        max: 16,
      }],
      memberCount: 10,
      unit: "m/s",
      variableLabel: "Wind speed",
      latitude: 42,
      longitude: -71,
    },
  },
  phase: "ready",
  message: "",
  locationLabel: "Boston",
  temperatureUnit: { id: "tempF", label: "°F" },
  precipitationUnit: { id: "in/h", label: "in/hr" },
  mapPrecipitationRate: {
    timestamp: date.getTime(),
    value: 27.68,
    unit: "mm/h",
  },
  windSpeedUnit: { id: "mph", label: "mph" },
  timeZone: "America/New_York",
}));

assert.match(markup, /22\.4<small> mph<\/small>/);
assert.match(markup, /1\.1 in\/hr/);
assert.match(markup, />36 mph<\/span>/);
assert.doesNotMatch(markup, /m\/s/);

console.log("Meteogram checks passed");
