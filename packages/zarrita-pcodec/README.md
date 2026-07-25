# Zarrita PCodec WASM adapter

Minimal read-only PCodec decoder for the Earthmover open ERA5 repository.
PCodec's standalone stream contains the decode parameters, so the Zarr codec's
`level` configuration is intentionally ignored.

## Build

Prerequisites:

- Rust with the `wasm32-unknown-unknown` target
- `wasm-pack`

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
cd packages/zarrita-pcodec
wasm-pack build --release --target web --out-dir pkg
```

The release profile intentionally skips `wasm-opt`. The optimizer bundled with
`wasm-pack` currently rejects the bulk-memory instructions emitted by this Rust
toolchain; the unoptimized WebAssembly module runs correctly in current
browsers.

The generated module is registered with Zarrita by `app/codecs/pcodec.ts`.
That adapter supports the ERA5 field dtype (`float32`) plus `float64`. ERA5
coordinate arrays use standard Zstd/bytes codecs and do not require PCodec.

The adapter and generated package are validated by `npm run check:data` against
a real Earthmover ERA5 spatial chunk and a one-year point time series.
