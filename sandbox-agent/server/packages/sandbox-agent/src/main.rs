use sandbox_agent::cli::run_sandbox_agent;

fn main() {
    if let Err(err) = run_sandbox_agent() {
        tracing::error!(error = %err, "sandbox-agent failed");
        std::process::exit(1);
    }
}
