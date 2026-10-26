# Zarr globe viewer

A browser-only viewer for multidimensional Zarr and Icechunk data. It uses
[`@carbonplan/zarr-layer`](https://github.com/carbonplan/zarr-layer), MapLibre,
and direct object-store reads without an application server.

The default is the public, map-optimized Dynamical.org WeatherNext 2 virtual
Icechunk store. The catalog also includes Google ARCO ERA5, Earthmover ERA5,
and role-optimized Dynamical.org GFS, GEFS, HRRR, AIFS, IFS ENS, and ICON
stores. See [`docs/datasets.md`](docs/datasets.md) for the catalog and source
roles.

## Features

- Globe and Mercator rendering with metadata-driven variable and axis controls
- Absolute-time calendars, lead-time sliders, keyboard navigation, and playback
- Chunk caching and metadata-adaptive prefetch for direct Icechunk reads
- Unit conversion, colormaps, opacity, inspection, and model comparisons
- Point forecasts and historical point series where a series source is defined
- ASOS/AWOS station overlay and station-vs-grid comparisons
- Browser Gribberish decoding for virtual GRIB-backed maps
- Static production build with no backend runtime

## Run locally

```sh
npm install --force
npm run dev
```

The development and preview servers send cross-origin-isolation headers. A
static deployment uses the bundled service worker and enters isolated mode only
when a selected source requires it.

## Checks

```sh
npm test
```

`npm run build` writes the static site to `dist/`. Remote-data checks are
explicit (`npm run check:data`, `npm run check:new-data`, and
`npm run check:ecmwf-data`) because they read live third-party stores.

## Project structure

- `app/ZarrViewer.tsx` — React and MapLibre orchestration
- `app/data/types.ts` — shared axis, variable, store, and series model
- `app/data/dimensions.ts` — canonical dimension-role predicates
- `app/data/axes.ts` — pure time, coordinate, and selection logic
- `app/data/point-series.ts` — native and derived point extraction
- `app/viewer/` and `app/components/` — reusable viewer policy and UI
- `app/catalog.ts` — dataset roles, capabilities, and pinned fallbacks
- `app/dataset.ts` — store discovery, STAC resolution, and metadata loading
- `app/codecs/` and `packages/zarrita-pcodec` — browser codec adapters

See [`docs/architecture.md`](docs/architecture.md) for dependency boundaries
and the verification contract.

Each logical dataset can define independent `map` and `series` sources. The
Dynamical.org entries resolve their `icechunk-https` URL through the public
STAC collection document, so catalog metadata remains current without putting
credentials in the viewer. Google ARCO's compact logical time axis is mapped
to its physical storage index explicitly; the remote check covers that
translation.
