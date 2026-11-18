use std::env;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

fn main() {
    init_logging();
    let mut out: Option<PathBuf> = None;
    let mut stdout = false;
    let mut args = env::args().skip(1).peekable();
    while let Some(arg) = args.next() {
        if arg == "--stdout" {
            stdout = true;
            continue;
        }
        if arg == "--out" {
            if let Some(value) = args.next() {
                out = Some(PathBuf::from(value));
            }
            continue;
        }
        if let Some(value) = arg.strip_prefix("--out=") {
            out = Some(PathBuf::from(value));
            continue;
        }
        if out.is_none() {
            out = Some(PathBuf::from(arg));
        }
    }

    let schema = sandbox_agent_openapi_gen::OPENAPI_JSON;
    if stdout {
        write_stdout(schema);
        return;
    }

    let out = out.unwrap_or_else(|| PathBuf::from("openapi.json"));
    if let Err(err) = fs::write(&out, schema) {
        tracing::error!(path = %out.display(), error = %err, "failed to write openapi schema");
        std::process::exit(1);
    }
}

fn init_logging() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::registry()
        .with(filter)
        .with(
            tracing_logfmt::builder()
                .layer()
                .with_writer(std::io::stderr),
        )
        .init();
}

fn write_stdout(text: &str) {
    let mut out = std::io::stdout();
    let _ = out.write_all(text.as_bytes());
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}
