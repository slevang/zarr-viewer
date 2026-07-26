# Architecture

The application has three layers. Dependencies should flow down this list, not
back upward.

1. **UI and orchestration** — `ZarrViewer.tsx`, `SeriesComparison.tsx`, and
   `app/components/` own React state, effects, MapLibre lifecycle, and rendering.
2. **Viewer and data policy** — `app/viewer/`, `app/data/axes.ts`, unit
   conversion, derived-variable rules, and color-range estimation are
   deterministic modules that can be understood and checked without opening a
   remote store.
3. **I/O adapters** — `app/dataset.ts`, `app/data/point-series.ts`,
   `app/asos.ts`, `app/derived-store.ts`, and `app/codecs/` translate external
   Zarr, Icechunk, Parquet, and codec APIs into the shared domain model.

## Data boundary

`app/data/types.ts` is the shared vocabulary: axes, variables, stores,
selections, and point-series results. Type-only consumers should import it
directly so they do not accidentally depend on store initialization.

`app/data/dimensions.ts` is the canonical interpretation of dimension names.
Spatial overrides, initialization aliases, valid-time names, and ensemble
aliases belong there rather than in loader or UI conditionals.

`app/data/axes.ts` owns all pure coordinate and temporal-selection behavior:
defaults, reconciliation, valid-time calculations, formatting, and map
coordinate normalization. It may depend on the catalog and shared types, but
must not fetch data or initialize codecs.

`app/data/point-series.ts` owns spatial index lookup plus native and derived
history/forecast reads. `app/dataset.ts` discovers stores and metadata. It
re-exports the data types, axis functions, and point-series functions as a
compatibility façade for older consumers. New code should use the narrow module
unless it genuinely needs store discovery.

## Viewer boundary

`ZarrViewer.tsx` is the application orchestrator. It owns long-lived React and
MapLibre resources and coordinates async requests. Logic that does not require a
hook or a live map belongs elsewhere:

- `viewer/playback.ts` — cadence, chunk keys, and prefetch sizing
- `viewer/variables.ts` — cross-dataset variable and time matching
- `viewer/display.ts` — status, formatting, and initial display ranges
- `viewer/preferences.ts` — URL and local-storage persistence
- `viewer/stations.ts` — GeoJSON station parsing and station labels
- `components/DeferredCalendarInput.tsx` — deferred date-input interaction

This split is intentional: a change to prefetch policy should not require
loading the full React component, and a UI-only change should not require
reading store-backend implementations.

## Store loading

Catalog entries describe logical datasets with independent `map` and `series`
sources. `loadStoreInfo` dispatches to the adapter for the configured source
kind, decorates native variables with derived-variable matches, and caches the
result by dataset, role, source, and target initialization date.

Source capabilities also describe physical layout and direct-chunk support.
Chunking labels and playback behavior derive from those capabilities, never
from dataset IDs. Unspecified layouts default to time-series chunking.

Point-series reads in `app/data/point-series.ts` share the selected domain
model. Native and derived history and forecast paths converge on
`loadPointSeries`; forecast results are reduced to stable quantiles before
reaching React. Coordinate arrays are cached once per `StoreInfo`, so derived
variables and model comparisons do not repeatedly fetch and decode identical
latitude/longitude chunks.

## Verification

`npm test` is the offline contract. It runs lint, TypeScript, focused
deterministic checks, the production build, and static-build validation.
TypeScript scripts use `node --import tsx`, avoiding a separate IPC process.
`check:viewer` covers the extracted playback, display, and station policies.

Live-store checks are separate because upstream data and credentials are not
part of the repository contract:

```sh
npm run check:data
npm run check:new-data
```

When moving code, first preserve the existing exported façade, then migrate
internal imports toward the narrow module. Add deterministic checks beside the
closest existing `scripts/check-*.ts` contract.
