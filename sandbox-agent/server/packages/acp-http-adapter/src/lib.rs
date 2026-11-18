use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use app::build_router;
use process::AdapterRuntime;
use registry::LaunchSpec;

pub mod app;
pub mod process;
pub mod registry;

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub registry_json: String,
    pub registry_agent_id: Option<String>,
    pub rpc_timeout: Duration,
}

pub async fn run_server(
    config: ServerConfig,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let launch =
        LaunchSpec::from_registry_blob(&config.registry_json, config.registry_agent_id.as_deref())?;
    let runtime = Arc::new(AdapterRuntime::start(launch, config.rpc_timeout).await?);
    run_server_with_runtime(config.host, config.port, runtime).await
}

pub async fn run_server_with_runtime(
    host: String,
    port: u16,
    runtime: Arc<AdapterRuntime>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let app = build_router(runtime.clone());
    let addr: SocketAddr = format!("{host}:{port}").parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(addr = %addr, "acp-http-adapter listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(runtime))
        .await?;
    Ok(())
}

async fn shutdown_signal(runtime: Arc<AdapterRuntime>) {
    let _ = tokio::signal::ctrl_c().await;
    runtime.shutdown().await;
}
