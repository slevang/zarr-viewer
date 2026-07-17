# Zarr globe viewer

A browser-only prototype for exploring multidimensional Zarr data on an interactive globe. It uses [`@carbonplan/zarr-layer`](https://github.com/carbonplan/zarr-layer) with MapLibre and reads chunks directly from object storage without an application server.

The included dataset adapter uses the public ARCO ERA5 store as a realistic test source. Dataset-specific metadata, coordinates, and request handling are isolated in `app/dataset.ts` so the rendering and interface can evolve toward a more general viewer.

## Features

- Globe and Mercator rendering with a labeled basemap and coastline overlay
- Metadata-driven variable names and units
- Time and level selection, keyboard navigation, playback, and nearby-frame preloading
- Automatic and editable color limits, selectable colormaps, and opacity control
- Click-to-inspect values
- Static production build with no backend runtime

## Run locally

```sh
npm install
npm run dev
```

Open <http://localhost:3000>.

## Checks

```sh
npm test
```

`npm run build` writes the static site to `dist/`. A manual GitHub Pages workflow is included but does not deploy unless explicitly run.

## Project structure

- `app/ZarrViewer.tsx` — map, layer, interaction, and playback state
- `app/dataset.ts` — source URL and dataset-specific metadata/coordinate adapter
- `app/colormaps.ts` — palettes and lightweight default-palette rules
- `scripts/build-coastline.mjs` — generates the bundled Natural Earth coastline

This remains a prototype rather than a universal Zarr reader. The current adapter expects consolidated Zarr v2 metadata; `time`, `latitude`, and `longitude` dimensions; and an optional `level` dimension. Supporting a substantially different store should be done by replacing the adapter rather than adding dataset branches to the viewer.
