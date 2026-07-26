# Open dataset catalog

Checked against the [dynamical.org STAC catalog](https://stac.dynamical.org/catalog.json),
the [AWS Open Data ERA5 listing](https://registry.opendata.aws/earthmover-era5/),
the [WeatherZarr catalog](https://www.weatherzarr.com/), and the
[GemAI v3 release](https://gemv3.salient-open-data.com/) on 2026-07-25.

The browser uses the HTTPS forms. S3 forms are included for Python, CLI, and
server-side clients. Dynamical's versions are intentionally pinned: future
catalog releases can change them, so update `app/catalog.ts` and this table
together.

## WeatherZarr ECMWF IFS

Latest-run pointer:

- `https://weatherzarr.com/data/ecmwf-ifs025/latest.json`
- Access: anonymous, CORS-enabled HTTPS
- Resolution: global 0.25°
- Retention: rolling 240 hours

Each run publishes one Zarr v3 store per variable and layout. The viewer reads
the latest pointer and run manifest, then presents the separate stores as one
logical dataset. The map layout uses chunks of
`valid_time 1 × latitude 721 × longitude 1024`; the point layout uses
`valid_time 61 × latitude 64 × longitude 64`. Both use standard bytes and
Zstandard codecs. The current source variables are `2t`, `2d`, `10u`, `10v`,
`tcc`, `tp`, `mslp`, `z500`, `t850`, `u250`, and `v250`.

WeatherZarr is the default map because it provides a current, efficiently
chunked global forecast. It is a new third-party rolling service rather than a
permanent archive; the catalog entry can be replaced by Dynamical's virtual
global store when that becomes available.

## Google WeatherNext 2

Repository root:

- HTTPS: `https://storage.googleapis.com/weathernext/weathernext_2_0_0/zarr`
- Format: consolidated Zarr v2 forecast repositories
- Grid: global 0.25°
- Ensemble: 64 samples
- Forecast range: 60 six-hour steps
- Access: Google account with WeatherNext Cloud Storage permission

The viewer generates paths directly from a requested initialization date rather
than listing the bucket. For example:

`2025_to_present/20260725_18hr_01_preds/predictions.zarr`

Dates from 2022–2024 use the corresponding annual period, such as
`2024_to_2025`. The adapter targets the 00/06/12/18 UTC cycles and probes recent
generated `.zmetadata` paths backward to tolerate publication latency or a
missing run. Object reads use a short-lived bearer token obtained by Google
Identity Services with the `devstorage.read_only` scope.

The token is retained in browser `localStorage`, so tabs, reloads, and browser
restarts reuse it while it remains valid. It is removed on disconnect or expiry
and is never sent to the viewer host as a cookie. Authorization occurs in the
non-isolated `/google-auth.html` bridge while the main viewer remains isolated
for the HRRR decoder. No OAuth client secret belongs in a static browser
application.

WeatherNext is currently map-only in the viewer. Its arrays are chunked as one
sample, one lead time, and a full global field, so a point time series would
needlessly fetch many complete maps. The viewer supplies an initialization-time
calendar and slider from the known six-hourly run schedule; changing it opens
the generated store path, while the native Zarr `time` coordinate remains the
lead-time selector. While the OAuth app is in Google's Testing state,
accounts must be explicitly listed under **Google Auth Platform → Audience →
Test users** and must periodically reauthorize.

## dynamical.org

| Dataset ID | HTTPS Icechunk v2 repository | S3 repository |
| --- | --- | --- |
| `noaa-gfs-analysis` | `https://dynamical-noaa-gfs.s3.us-west-2.amazonaws.com/noaa-gfs-analysis/v0.1.0.icechunk` | `s3://dynamical-noaa-gfs/noaa-gfs-analysis/v0.1.0.icechunk/` |
| `noaa-gfs-forecast` | `https://dynamical-noaa-gfs.s3.us-west-2.amazonaws.com/noaa-gfs-forecast/v0.2.7.icechunk` | `s3://dynamical-noaa-gfs/noaa-gfs-forecast/v0.2.7.icechunk/` |
| `noaa-gefs-forecast-35-day` | `https://dynamical-noaa-gefs.s3.us-west-2.amazonaws.com/noaa-gefs-forecast-35-day/v0.2.0.icechunk` | `s3://dynamical-noaa-gefs/noaa-gefs-forecast-35-day/v0.2.0.icechunk/` |
| `noaa-gefs-analysis` | `https://dynamical-noaa-gefs.s3.us-west-2.amazonaws.com/noaa-gefs-analysis/v0.1.2.icechunk` | `s3://dynamical-noaa-gefs/noaa-gefs-analysis/v0.1.2.icechunk/` |
| `noaa-hrrr-forecast-48-hour` | `https://dynamical-noaa-hrrr.s3.us-west-2.amazonaws.com/noaa-hrrr-forecast-48-hour/v0.1.0.icechunk` | `s3://dynamical-noaa-hrrr/noaa-hrrr-forecast-48-hour/v0.1.0.icechunk/` |
| `noaa-hrrr-forecast-48-hour-virtual` | `https://dynamical-noaa-hrrr.s3.us-west-2.amazonaws.com/noaa-hrrr-forecast-48-hour-virtual/v0.5.0.icechunk` | `s3://dynamical-noaa-hrrr/noaa-hrrr-forecast-48-hour-virtual/v0.5.0.icechunk/` |
| `noaa-hrrr-analysis` | `https://dynamical-noaa-hrrr.s3.us-west-2.amazonaws.com/noaa-hrrr-analysis/v0.2.0.icechunk` | `s3://dynamical-noaa-hrrr/noaa-hrrr-analysis/v0.2.0.icechunk/` |
| `ecmwf-aifs-single-forecast` | `https://dynamical-ecmwf-aifs-single.s3.us-west-2.amazonaws.com/ecmwf-aifs-single-forecast/v0.1.0.icechunk` | `s3://dynamical-ecmwf-aifs-single/ecmwf-aifs-single-forecast/v0.1.0.icechunk/` |
| `ecmwf-aifs-ens-forecast` | `https://dynamical-ecmwf-aifs-ens.s3.us-west-2.amazonaws.com/ecmwf-aifs-ens-forecast/v0.1.0.icechunk` | `s3://dynamical-ecmwf-aifs-ens/ecmwf-aifs-ens-forecast/v0.1.0.icechunk/` |
| `ecmwf-ifs-ens-forecast-15-day-0-25-degree` | `https://dynamical-ecmwf-ifs-ens.s3.us-west-2.amazonaws.com/ecmwf-ifs-ens-forecast-15-day-0-25-degree/v0.1.0.icechunk` | `s3://dynamical-ecmwf-ifs-ens/ecmwf-ifs-ens-forecast-15-day-0-25-degree/v0.1.0.icechunk/` |
| `dwd-icon-eu-forecast-5-day` | `https://dynamical-dwd-icon-eu.s3.us-west-2.amazonaws.com/dwd-icon-eu-forecast-5-day/v0.2.0.icechunk` | `s3://dynamical-dwd-icon-eu/dwd-icon-eu-forecast-5-day/v0.2.0.icechunk/` |

All are anonymous public stores in `us-west-2`. The virtual HRRR repository
contains byte-range references to NOAA GRIB objects and uses the `gribberish`
array-to-bytes codec. The other repositories use ordinary Zarr v3 codec
pipelines, including sharded arrays.

HRRR is represented as one logical dataset. Its map role resolves to the
GRIB-backed repository and its series role resolves to the materialized
repository. HRRR analysis remains cataloged separately and uses its currently
available time-oriented store for maps until a spatial counterpart exists.

## dynamical.org ASOS/AWOS observations

Catalog: `https://dynamical.org/catalog/asos-parquet/`

Annual partitions:

- HTTPS:
  `https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/dynamical/asos-parquet/year%3D{YYYY}/data.parquet`
- S3:
  `s3://us-west-2.opendata.source.coop/dynamical/asos-parquet/year={YYYY}/data.parquet`
- Format: GeoParquet with Zstandard-compressed columns
- Access: anonymous, CORS-enabled HTTP byte ranges

Files are sorted by station and expose station and timestamp statistics for
each row group. The viewer uses Hyparquet row-group pruning, column projection,
and HTTP range reads, so selecting one station does not download the complete
annual file. Temperature, dew point, relative humidity, wind speed, mean
sea-level pressure, and precipitation are mapped to corresponding station
fields when the selected grid variable has a direct observational equivalent.

`public/asos-stations.geojson` is a compact active-station manifest generated
from the current-year partition. Run `npm run build:asos-manifest` to refresh
it as the reporting network changes.

## Earthmover open ERA5

Repository:

- HTTPS: `https://earthmover-icechunk-era5.s3.us-east-1.amazonaws.com/icechunkV2`
- S3: `s3://earthmover-icechunk-era5/icechunkV2`
- Region: `us-east-1`
- Access: anonymous

The repository has three variable groups, each with two equivalent layouts:

| Group | Map-oriented layout | Time-series-oriented layout |
| --- | --- | --- |
| Single-level variables | `single/spatial` | `single/temporal` |
| Pressure-level variables | `pressure/spatial` | `pressure/temporal` |
| Curated 500 hPa variables | `500hPa/spatial` | `500hPa/temporal` |

The spatial layout stores one global field per time chunk. The temporal layout
stores long time spans in small spatial tiles and is the right source for
pointwise historical series. Both layouts use the `numcodecs.pcodec` codec for
data arrays. Coordinates use standard codecs. Data arrays are decoded by the
small Rust/WASM package in `packages/zarrita-pcodec`.

## Salient GemAI v3 reforecast

Repository:

- HTTPS: `https://gemv3-reforecast.salient-open-data.com/forecast`
- Format: inline-consolidated Zarr v3
- Coverage: 3,443 forecast dates from 2000–2025
- Grid: global 0.25°
- Ensemble: 50 samples
- Forecast range: 126 days

Data arrays have outer chunks of
`forecast_date 1 × lead 7 × sample 50 × lat 288 × lon 288` and sharded inner
chunks of `1 × 7 × 50 × 36 × 36`. The inner codec pipeline combines
`numcodecs.fixedscaleoffset` with `numcodecs.pcodec`; both read-only adapters
are registered by the viewer.

The endpoint currently omits browser CORS response headers. Node and server-side
reads work, including full 50-member point forecasts, but static browser reads
will fail until the R2 bucket CORS policy allows the viewer origin (or `*` for
the public dataset). Purge the custom-domain cache after applying the policy so
existing objects begin returning the new headers.

## Source-role policy

Catalog entries describe logical datasets rather than individual physical
stores. Each entry can independently provide `sources.map` and
`sources.series`:

- A shared source means the available store serves both roles.
- Different groups in one repository cover layouts such as Earthmover ERA5.
- Different repositories cover HRRR's spatial GRIB-backed maps and materialized
  point forecasts.
- An absent role disables that capability.

A map click loads the selected logical dataset's series source when present.
Each read is limited to a 15-day window; ensemble stores are reduced to
min/10/25/50/75/90/max quantiles. Projected sources use their configured spatial
dimension names and projection definition to convert the clicked WGS84 point
before selecting the nearest grid cell.

## Display units

Variable unit attributes are normalized from common CF spellings and parsed by
JS-Quantities. Recognized quantities expose a short list of compatible display
units, currently including temperature, pressure, speed, and length. Color
limits remain stored in each array's native units while legend edits,
inspection values, and overlaid point series are converted for display. The
selected unit is remembered by physical quantity, so every compatible model in
one comparison uses the same scale.

## Browser compatibility

| Source | Icechunk metadata | Data codec | Viewer status |
| --- | --- | --- | --- |
| Dynamical materialized stores | `icechunk-js` | Zarrita standard codecs | Ready for regular latitude/longitude grids; store reads use a bounded 32-request queue and 1 GiB byte cache |
| Materialized HRRR forecast | `icechunk-js` | Sharded Blosc/Zstd | Reserved for point-series reads because its time-oriented chunks make map reads impractical |
| Dynamical virtual HRRR | `icechunk-js` virtual ranges | Gribberish WASM adapter | Codec validated; explicit Lambert conformal grid; viewer is always cross-origin isolated |
| Earthmover ERA5 | `icechunk-js` | PCodec WASM adapter | Ready |
| Google ARCO ERA5 | FetchStore / consolidated Zarr | Zarrita standard codecs | Ready |
| Google WeatherNext 2 | Authenticated GCS FetchStore | Zarrita standard codecs | Map-only; requires an authorized Google account |
| WeatherZarr IFS | Manifest-backed multiplexed FetchStore | Zarrita standard codecs | Ready; current default, rolling retention |
| Salient GemAI v3 | FetchStore / consolidated Zarr | FixedScaleOffset + PCodec WASM | Decoder validated; awaiting data-host CORS |
