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

Then import and call `registerPcodec()` before opening the ERA5 arrays. The
first implementation supports the only required ERA5 field dtype (`float32`)
and `float64` for simple follow-on use. The ERA5 coordinate arrays use standard
Zstd/bytes codecs and do not require PCodec.

This package is not imported by the application until a generated `pkg/`
exists and a real Earthmover chunk passes a bitwise comparison against the
Python `pcodec` decoder.
