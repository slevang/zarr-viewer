# Zarr globe viewer

A browser-only prototype for exploring multidimensional Zarr and Icechunk data
on an interactive globe. It uses
[`@carbonplan/zarr-layer`](https://github.com/carbonplan/zarr-layer) with
MapLibre and reads chunks directly from object storage without an application
server.

The viewer includes Google ARCO ERA5 plus the public dynamical.org weather
catalog. Icechunk repositories are opened with `icechunk-js`; variables and
all non-spatial dimensions are discovered from Zarr metadata. See
[`docs/datasets.md`](docs/datasets.md) for pinned HTTPS/S3 paths and codec
compatibility.

## Features

- Globe and Mercator rendering with a labeled basemap and coastline overlay
- Dataset and metadata-driven variable selection
- Dynamic controls for time, lead time, initialization time, ensemble/sample,
  level, and other non-spatial dimensions
- Calendar inputs for absolute time axes plus sliders for every dimension
- Keyboard navigation and load-gated per-time-axis playback
- Metadata-adaptive 1–32 worker prefetch with up to 120 frames of read-ahead
- One GiB compressed-chunk cache for direct Icechunk playback reuse
- Cadence-aware playback targeting six data-hours per real-time second
- Full-frame per-variable color limits, selectable colormaps, and opacity control
- Metadata-driven unit conversion with shared units across model comparisons
- Click-to-inspect values
- Click-to-plot 15-day windows from Earthmover's temporal ERA5 layout
- Independent comparison-dataset selector with arbitrary overlaid model series
- Toggleable ASOS/AWOS station overlay with decoded observations at map time
- Fifteen-day station traces and live grid-minus-station bias for compatible fields
- Ensemble forecast envelopes with min/10/25/50/75/90/max quantiles by default
- Explicit per-dataset opt-in for point time-series extraction
- Browser Gribberish codec support for virtual HRRR chunks
- Static production build with no backend runtime

## Run locally

```sh
npm install --force
npm run dev
```

`--force` is required because the browser Gribberish build is published with a
`wasm32` platform marker while this project intentionally bundles it from a
normal macOS/Linux development machine.

Open <http://localhost:3000>.

The Vite development and preview servers include the cross-origin-isolation
headers required by the virtual HRRR Gribberish decoder.

## Checks

```sh
npm test
```

`npm run build` writes the static site to `dist/`. A manual GitHub Pages workflow is included but does not deploy unless explicitly run.

## Project structure

- `app/ZarrViewer.tsx` — map, layer, interaction, and playback state
- `app/catalog.ts` — pinned public dataset endpoints and compatibility flags
- `app/dataset.ts` — generic metadata, coordinate, and selector adapter
- `app/asos.ts` — lazy browser Parquet queries for point observations
- `app/asos-types.ts` — station, observation, and map-overlay types
- `app/units.ts` — CF-unit normalization and JS-Quantities conversion layer
- `app/codecs/gribberish.ts` — read-only Zarrita codec for virtual GRIB chunks
- `app/colormaps.ts` — palettes and lightweight default-palette rules
- `packages/zarrita-pcodec` — Rust/WASM PCodec decoder for Earthmover ERA5
- `scripts/build-coastline.mjs` — generates the bundled Natural Earth coastline
- `scripts/build-asos-manifest.ts` — refreshes the checked-in active-station GeoJSON

This remains a prototype rather than a universal Zarr reader. Regular
latitude/longitude Icechunk stores are the most complete path. HRRR has an
explicit Lambert conformal grid configuration. The materialized HRRR forecast
is retained for point-series reads but omitted from the map selector; the
GRIB-backed HRRR forecast is the map source. HRRR additionally
requires cross-origin-isolation headers because the upstream Gribberish WASM
package uses shared memory; it is loaded lazily so this requirement does not
affect other datasets.

Each logical dataset in `app/catalog.ts` has independent optional `map` and
`series` sources. The two roles may resolve to the same store, different groups
in one repository, or entirely separate repositories. HRRR pairs its
GRIB-backed spatial source with its materialized temporal source; Earthmover
ERA5 pairs `single/spatial` with `single/temporal`. Current Dynamical datasets
without a dedicated spatial source reuse their existing store for maps and
point series until a better map source is published.

The optional station overlay reads a compact checked-in manifest derived from
the current ASOS partition. Clicking a station lazily loads Hyparquet and reads
only the matching station row group and requested columns from the relevant
year-partitioned GeoParquet file. Refresh the manifest with
`npm run build:asos-manifest`.
