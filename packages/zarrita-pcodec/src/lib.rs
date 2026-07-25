use pco::standalone::simple_decompress;
use wasm_bindgen::prelude::*;

fn js_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}

#[wasm_bindgen]
pub fn decompress_f32(src: &[u8]) -> Result<Box<[f32]>, JsValue> {
    simple_decompress::<f32>(src)
        .map(Vec::into_boxed_slice)
        .map_err(js_error)
}

#[wasm_bindgen]
pub fn decompress_f64(src: &[u8]) -> Result<Box<[f64]>, JsValue> {
    simple_decompress::<f64>(src)
        .map(Vec::into_boxed_slice)
        .map_err(js_error)
}
