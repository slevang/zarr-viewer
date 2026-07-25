# Open dataset catalog

Checked against the [dynamical.org STAC catalog](https://stac.dynamical.org/catalog.json)
and the [AWS Open Data ERA5 listing](https://registry.opendata.aws/earthmover-era5/)
on 2026-07-24.

The browser uses the HTTPS forms. S3 forms are included for Python, CLI, and
server-side clients. Dynamical's versions are intentionally pinned: future
catalog releases can change them, so update `app/catalog.ts` and this table
together.

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

## Source-role policy

Catalog entries describe logical datasets rather than individual physical
stores. Each entry can independently provide `sources.map` and
`sources.series`:

- A shared source means the available store serves both roles.
- Different groups in one repository cover layouts such as Earthmover ERA5.
- Different repositories cover HRRR's spatial GRIB-backed maps and materialized
  point forecasts.
- An absent role disables that capability, as with Google ARCO ERA5 point
  histories.

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
| Dynamical virtual HRRR | `icechunk-js` virtual ranges | Gribberish WASM adapter | Codec validated; explicit Lambert conformal grid; requires cross-origin-isolated hosting |
| Earthmover ERA5 | `icechunk-js` | PCodec WASM adapter | Ready |
| Google ARCO ERA5 | FetchStore / consolidated Zarr | Zarrita standard codecs | Ready; retained as the original map source |
