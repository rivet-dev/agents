use std::time::Duration;

use acp_http_adapter::{run_server, ServerConfig};
use clap::Parser;

#[derive(Debug, Parser)]
#[command(name = "acp-http-adapter")]
#[command(about = "Minimal ACP HTTP->stdio adapter", version)]
struct Cli {
    #[arg(long, default_value = "127.0.0.1")]
    host: String,

    #[arg(long, default_value_t = 7591)]
    port: u16,

    #[arg(long)]
    registry_json: String,

    #[arg(long)]
    registry_agent_id: Option<String>,

    #[arg(long)]
    rpc_timeout_ms: Option<u64>,
}

#[tokio::main]
async fn main() {
    if let Err(err) = run().await {
        tracing::error!(error = %err, "acp-http-adapter failed");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let started = std::time::Instant::now();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .compact()
        .init();

    let cli = Cli::parse();
    tracing::info!(
        host = %cli.host,
        port = cli.port,
        startup_ms = started.elapsed().as_millis() as u64,
        "acp-http-adapter.run: starting server"
    );
    run_server(ServerConfig {
        host: cli.host,
        port: cli.port,
        registry_json: cli.registry_json,
        registry_agent_id: cli.registry_agent_id,
        rpc_timeout: cli
            .rpc_timeout_ms
            .map(Duration::from_millis)
            .unwrap_or_else(|| Duration::from_secs(120)),
    })
    .await
}
