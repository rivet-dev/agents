use std::sync::Mutex;
use tauri::{AppHandle, LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

struct BackendState {
    child: Mutex<Option<CommandChild>>,
}

#[tauri::command]
fn get_backend_url() -> String {
    "http://127.0.0.1:7741".to_string()
}

#[tauri::command]
async fn backend_health() -> Result<bool, String> {
    match reqwest::get("http://127.0.0.1:7741/v1/rivet/metadata").await {
        Ok(resp) => Ok(resp.status().is_success()),
        Err(_) => Ok(false),
    }
}

async fn wait_for_backend(timeout_secs: u64) -> Result<(), String> {
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(timeout_secs);

    loop {
        if start.elapsed() > timeout {
            return Err(format!(
                "Backend failed to start within {} seconds",
                timeout_secs
            ));
        }

        match reqwest::get("http://127.0.0.1:7741/v1/rivet/metadata").await {
            Ok(resp) if resp.status().is_success() => return Ok(()),
            _ => {}
        }

        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}

fn spawn_backend(app: &AppHandle) -> Result<(), String> {
    let sidecar = app
        .shell()
        .sidecar("sidecars/foundry-backend")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?
        .args(["start", "--host", "127.0.0.1", "--port", "7741"]);

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("Failed to spawn backend sidecar: {}", e))?;

    // Store the child process handle for cleanup
    let state = app.state::<BackendState>();
    *state.child.lock().unwrap() = Some(child);

    // Log sidecar stdout/stderr in a background task
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    eprintln!("[foundry-backend] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[foundry-backend] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!(
                        "[foundry-backend] process exited with code {:?}",
                        payload.code
                    );
                    break;
                }
                CommandEvent::Error(err) => {
                    eprintln!("[foundry-backend] error: {}", err);
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(BackendState {
            child: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![get_backend_url, backend_health])
        .setup(|app| {
            // Create main window programmatically so we can set traffic light position
            let url = if cfg!(debug_assertions) {
                WebviewUrl::External("http://localhost:4173".parse().unwrap())
            } else {
                WebviewUrl::default()
            };

            let mut builder = WebviewWindowBuilder::new(app, "main", url)
                .title("Foundry")
                .inner_size(1280.0, 800.0)
                .min_inner_size(900.0, 600.0)
                .resizable(true)
                .theme(Some(tauri::Theme::Dark))
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);

            #[cfg(target_os = "macos")]
            {
                builder = builder.traffic_light_position(LogicalPosition::new(14.0, 14.0));
            }

            builder.build()?;

            // In debug mode, assume the developer is running the backend externally
            if cfg!(debug_assertions) {
                eprintln!("[foundry-desktop] Dev mode: skipping sidecar spawn. Run the backend separately.");
                return Ok(());
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = spawn_backend(&handle) {
                    eprintln!("[foundry-desktop] Failed to start backend: {}", e);
                    return;
                }

                match wait_for_backend(30).await {
                    Ok(()) => eprintln!("[foundry-desktop] Backend is ready."),
                    Err(e) => eprintln!("[foundry-desktop] {}", e),
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.state::<BackendState>();
                let child = state.child.lock().unwrap().take();
                if let Some(child) = child {
                    let _ = child.kill();
                    eprintln!("[foundry-desktop] Backend sidecar killed.");
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Foundry");
}
