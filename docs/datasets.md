# Dataset catalog

The viewer keeps logical dataset IDs stable while allowing each role to use a
different store. A `map` source is selected for spatial frames; a `series`
source is selected for point history or forecast extraction. Dynamical.org
sources carry a STAC collection ID and resolve the `icechunk-https` asset at
load time.

## Default: Google WeatherNext 2

`google-weathernext-2` opens the public
[`google-weathernext2-forecast-operational-virtual`](https://dynamical.org/catalog/google-weathernext2-forecast-operational-virtual/)
Icechunk store. It is spatially chunked, exposes initialization, lead, and
ensemble axes, and requires no Google account or credential input.

## Dynamical.org role pairs

The catalog uses virtual spatial stores for map reads and materialized stores
for point reads where both paths are available:

| Logical dataset | Map path | Series path |
| --- | --- | --- |
| NOAA GFS forecast | `noaa-gfs-forecast-virtual` | `noaa-gfs-forecast` |
| NOAA GFS analysis | `noaa-gfs-analysis-virtual` | `noaa-gfs-analysis` |
| NOAA GEFS forecast | `noaa-gefs-forecast-10-day-0-25-degree-virtual` | `noaa-gefs-forecast-35-day` |
| NOAA GEFS analysis | `noaa-gefs-analysis-0-25-degree-virtual` | `noaa-gefs-analysis` |
| NOAA HRRR analysis | `noaa-hrrr-analysis-virtual` | `noaa-hrrr-analysis` |
| ECMWF AIFS Single | `ecmwf-aifs-single-forecast-virtual` | `ecmwf-aifs-single-forecast` |

The GEFS map uses the 0.25° ten-day virtual product for responsive maps; the
35-day materialized product remains available for point forecasts. HRRR map
frames use the virtual GRIB-backed source and therefore request cross-origin
isolation. IFS ENS, AIFS ENS, and ICON EU remain single-store entries until a
role-specific optimized asset is published.

## Reanalysis and legacy paths

- Google ARCO ERA5 remains the open spatial store. Its compact logical time
  axis begins at 1940 while the physical coordinate array retains the 1900
  origin; `storageIndexOffset` keeps selectors and point reads aligned.
- ECMWF ARCO ERA5 remains available behind a CDS API key for its map and
  point-oriented stores.
- Earthmover ERA5 remains the PCodec-backed experimental historical series.

The former WeatherZarr IFS and Salient GemAI reforecast entries were removed.
Their manifests, credential bridge, and source-specific codecs are no longer
part of the application catalog. Old saved/share IDs for those entries resolve
deliberately to the WeatherNext 2 default instead of depending on catalog order.

## Adding or replacing a source

Add a `DatasetSourceConfig` in `app/catalog.ts`, prefer capability flags over
dataset-ID branches, and keep `map`/`series` responsibilities explicit. For a
Dynamical.org collection, set `stacCollectionId` and leave the resolved URL to
the STAC asset. Run `npm run check:new-data` after changing virtual stores and
`npm run check:data` after changing point-series layouts.
