# Zarr globe viewer

A browser-only prototype for exploring multidimensional Zarr and Icechunk data
on an interactive globe. It uses
[`@carbonplan/zarr-layer`](https://github.com/carbonplan/zarr-layer) with
MapLibre and reads chunks directly from object storage without an application
server.

The viewer defaults to the current WeatherZarr ECMWF IFS forecast and also
includes Google WeatherNext 2 for authorized users, Google ARCO ERA5, Salient
GemAI v3 reforecasts, and the public dynamical.org weather catalog. Icechunk
repositories are opened with `icechunk-js`; variables and all non-spatial
dimensions are discovered from Zarr metadata. See
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
- Manifest-backed paired spatial/temporal WeatherZarr stores
- Browser PCodec and FixedScaleOffset support for GemAI v3 reforecasts
- In-browser Google OAuth for authorized WeatherNext 2 map reads
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

The viewer remains cross-origin isolated so the threaded Gribberish decoder is
always available without a dataset-specific reload. Google authorization runs
in a small same-origin `/google-auth.html` bridge that is intentionally not
isolated and returns its result over a browser-local channel. The Vite
development/preview middleware and static service worker implement these
per-page headers.

### Google WeatherNext authorization

WeatherNext is not anonymous. Its dataset entry offers a **Connect Google**
button that requests the read-only Cloud Storage scope with Google Identity
Services in the non-isolated bridge page. The resulting short-lived access
token is retained in browser `localStorage`, removed on disconnect or expiry,
and restored across tabs and browser restarts while still valid. It is never
placed in a cookie, sent to the application host, or stored as a refresh token;
this static application does not use or contain a client secret.

The included public OAuth client is configured for the deployed GitHub Pages
origin. To use another deployment, create a Web application OAuth client and
set its client ID at build time:

```sh
VITE_GOOGLE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com npm run dev
```

Add the exact development and deployment origins under **Google Auth
Platform → Clients → Authorized JavaScript origins**, for example
`http://localhost:3000`, `http://127.0.0.1:3000`, and
`https://slevang.github.io`. While the app's publishing status is **Testing**,
also add each Google account under **Google Auth Platform → Audience → Test
users**. Add the Cloud Storage read-only scope under **Data Access**.

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
- `app/google-auth.ts` — persistent short-lived Google token and bridge flow
- `app/codecs/gribberish.ts` — read-only Zarrita codec for virtual GRIB chunks
- `app/codecs/fixedscaleoffset.ts` — read-only Numcodecs FixedScaleOffset adapter
- `app/colormaps.ts` — palettes and lightweight default-palette rules
- `packages/zarrita-pcodec` — Rust/WASM PCodec decoder for Earthmover ERA5 and GemAI v3
- `scripts/build-coastline.mjs` — generates the bundled Natural Earth coastline
- `scripts/build-asos-manifest.ts` — refreshes the checked-in active-station GeoJSON

This remains a prototype rather than a universal Zarr reader. Regular
latitude/longitude Icechunk stores are the most complete path. HRRR has an
explicit Lambert conformal grid configuration. The materialized HRRR forecast
is retained for point-series reads but omitted from the map selector; the
GRIB-backed HRRR forecast is the map source. HRRR additionally
requires cross-origin-isolation headers because the upstream Gribberish WASM
package uses shared memory. The viewer is therefore always isolated; only the
dedicated Google authorization bridge opts out.

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
