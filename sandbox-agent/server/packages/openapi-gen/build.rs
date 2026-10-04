use std::fs;
use std::io::{self, Write};
use std::path::Path;

use sandbox_agent::router::ApiDoc;
use utoipa::OpenApi;

fn main() {
    emit_stdout("cargo:rerun-if-changed=../sandbox-agent/src/router.rs");
    emit_stdout("cargo:rerun-if-changed=../sandbox-agent/src/lib.rs");

    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR not set");
    let out_path = Path::new(&out_dir).join("openapi.json");

    let openapi = ApiDoc::openapi();
    let json = serde_json::to_string_pretty(&openapi).expect("Failed to serialize OpenAPI spec");

    fs::write(&out_path, json).expect("Failed to write OpenAPI spec");
    emit_stdout(&format!(
        "cargo:warning=Generated OpenAPI spec at {}",
        out_path.display()
    ));
}

fn emit_stdout(message: &str) {
    let mut out = io::stdout();
    let _ = out.write_all(message.as_bytes());
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}
