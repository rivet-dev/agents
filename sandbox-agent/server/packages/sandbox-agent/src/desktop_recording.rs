use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::Mutex;

use sandbox_agent_error::SandboxError;

use crate::desktop_types::{
    DesktopRecordingInfo, DesktopRecordingListResponse, DesktopRecordingStartRequest,
    DesktopRecordingStatus, DesktopResolution,
};
use crate::process_runtime::{
    ProcessOwner, ProcessRuntime, ProcessStartSpec, ProcessStatus, RestartPolicy,
};

#[derive(Debug, Clone)]
pub struct DesktopRecordingContext {
    pub display: String,
    pub environment: std::collections::HashMap<String, String>,
    pub resolution: DesktopResolution,
}

#[derive(Debug, Clone)]
pub struct DesktopRecordingManager {
    process_runtime: Arc<ProcessRuntime>,
    recordings_dir: PathBuf,
    inner: Arc<Mutex<DesktopRecordingState>>,
}

#[derive(Debug, Default)]
struct DesktopRecordingState {
    next_id: u64,
    current_id: Option<String>,
    recordings: BTreeMap<String, RecordingEntry>,
}

#[derive(Debug, Clone)]
struct RecordingEntry {
    info: DesktopRecordingInfo,
    path: PathBuf,
}

impl DesktopRecordingManager {
    pub fn new(process_runtime: Arc<ProcessRuntime>, state_dir: PathBuf) -> Self {
        Self {
            process_runtime,
            recordings_dir: state_dir.join("recordings"),
            inner: Arc::new(Mutex::new(DesktopRecordingState::default())),
        }
    }

    pub async fn start(
        &self,
        context: DesktopRecordingContext,
        request: DesktopRecordingStartRequest,
    ) -> Result<DesktopRecordingInfo, SandboxError> {
        if find_binary("ffmpeg").is_none() {
            return Err(SandboxError::Conflict {
                message: "ffmpeg is required for desktop recording".to_string(),
            });
        }

        self.ensure_recordings_dir()?;

        {
            let mut state = self.inner.lock().await;
            self.refresh_locked(&mut state).await?;
            if state.current_id.is_some() {
                return Err(SandboxError::Conflict {
                    message: "a desktop recording is already active".to_string(),
                });
            }
        }

        let mut state = self.inner.lock().await;
        let id_num = state.next_id + 1;
        state.next_id = id_num;
        let id = format!("rec_{id_num}");
        let file_name = format!("{id}.mp4");
        let path = self.recordings_dir.join(&file_name);
        let fps = request.fps.unwrap_or(30).clamp(1, 60);
        let args = vec![
            "-y".to_string(),
            "-video_size".to_string(),
            format!("{}x{}", context.resolution.width, context.resolution.height),
            "-framerate".to_string(),
            fps.to_string(),
            "-f".to_string(),
            "x11grab".to_string(),
            "-i".to_string(),
            context.display,
            "-c:v".to_string(),
            "libx264".to_string(),
            "-preset".to_string(),
            "ultrafast".to_string(),
            "-pix_fmt".to_string(),
            "yuv420p".to_string(),
            path.to_string_lossy().to_string(),
        ];
        let snapshot = self
            .process_runtime
            .start_process(ProcessStartSpec {
                command: "ffmpeg".to_string(),
                args,
                cwd: None,
                env: context.environment,
                tty: false,
                interactive: false,
                owner: ProcessOwner::Desktop,
                restart_policy: Some(RestartPolicy::Never),
            })
            .await?;

        let info = DesktopRecordingInfo {
            id: id.clone(),
            status: DesktopRecordingStatus::Recording,
            process_id: Some(snapshot.id),
            file_name,
            bytes: 0,
            started_at: chrono::Utc::now().to_rfc3339(),
            ended_at: None,
        };
        state.current_id = Some(id.clone());
        state.recordings.insert(
            id,
            RecordingEntry {
                info: info.clone(),
                path,
            },
        );
        Ok(info)
    }

    pub async fn stop(&self) -> Result<DesktopRecordingInfo, SandboxError> {
        let (recording_id, process_id) = {
            let mut state = self.inner.lock().await;
            self.refresh_locked(&mut state).await?;
            let recording_id = state
                .current_id
                .clone()
                .ok_or_else(|| SandboxError::Conflict {
                    message: "no desktop recording is active".to_string(),
                })?;
            let process_id = state
                .recordings
                .get(&recording_id)
                .and_then(|entry| entry.info.process_id.clone());
            (recording_id, process_id)
        };

        if let Some(process_id) = process_id {
            let snapshot = self
                .process_runtime
                .stop_process(&process_id, Some(5_000))
                .await?;
            if snapshot.status == ProcessStatus::Running {
                let _ = self
                    .process_runtime
                    .kill_process(&process_id, Some(1_000))
                    .await;
            }
        }

        let mut state = self.inner.lock().await;
        self.refresh_locked(&mut state).await?;
        let entry = state
            .recordings
            .get(&recording_id)
            .ok_or_else(|| SandboxError::NotFound {
                resource: "desktop_recording".to_string(),
                id: recording_id.clone(),
            })?;
        Ok(entry.info.clone())
    }

    pub async fn list(&self) -> Result<DesktopRecordingListResponse, SandboxError> {
        let mut state = self.inner.lock().await;
        self.refresh_locked(&mut state).await?;
        Ok(DesktopRecordingListResponse {
            recordings: state
                .recordings
                .values()
                .map(|entry| entry.info.clone())
                .collect(),
        })
    }

    pub async fn get(&self, id: &str) -> Result<DesktopRecordingInfo, SandboxError> {
        let mut state = self.inner.lock().await;
        self.refresh_locked(&mut state).await?;
        state
            .recordings
            .get(id)
            .map(|entry| entry.info.clone())
            .ok_or_else(|| SandboxError::NotFound {
                resource: "desktop_recording".to_string(),
                id: id.to_string(),
            })
    }

    pub async fn download_path(&self, id: &str) -> Result<PathBuf, SandboxError> {
        let mut state = self.inner.lock().await;
        self.refresh_locked(&mut state).await?;
        let entry = state
            .recordings
            .get(id)
            .ok_or_else(|| SandboxError::NotFound {
                resource: "desktop_recording".to_string(),
                id: id.to_string(),
            })?;
        if !entry.path.is_file() {
            return Err(SandboxError::NotFound {
                resource: "desktop_recording_file".to_string(),
                id: id.to_string(),
            });
        }
        Ok(entry.path.clone())
    }

    pub async fn delete(&self, id: &str) -> Result<(), SandboxError> {
        let mut state = self.inner.lock().await;
        self.refresh_locked(&mut state).await?;
        if state.current_id.as_deref() == Some(id) {
            return Err(SandboxError::Conflict {
                message: "stop the active desktop recording before deleting it".to_string(),
            });
        }
        let entry = state
            .recordings
            .remove(id)
            .ok_or_else(|| SandboxError::NotFound {
                resource: "desktop_recording".to_string(),
                id: id.to_string(),
            })?;
        if entry.path.exists() {
            fs::remove_file(&entry.path).map_err(|err| SandboxError::StreamError {
                message: format!(
                    "failed to delete desktop recording {}: {err}",
                    entry.path.display()
                ),
            })?;
        }
        Ok(())
    }

    fn ensure_recordings_dir(&self) -> Result<(), SandboxError> {
        fs::create_dir_all(&self.recordings_dir).map_err(|err| SandboxError::StreamError {
            message: format!(
                "failed to create desktop recordings dir {}: {err}",
                self.recordings_dir.display()
            ),
        })
    }

    async fn refresh_locked(&self, state: &mut DesktopRecordingState) -> Result<(), SandboxError> {
        let ids: Vec<String> = state.recordings.keys().cloned().collect();
        for id in ids {
            let should_clear_current = {
                let Some(entry) = state.recordings.get_mut(&id) else {
                    continue;
                };
                let Some(process_id) = entry.info.process_id.clone() else {
                    Self::refresh_bytes(entry);
                    continue;
                };

                let snapshot = match self.process_runtime.snapshot(&process_id).await {
                    Ok(snapshot) => snapshot,
                    Err(SandboxError::NotFound { .. }) => {
                        Self::finalize_entry(entry, false);
                        continue;
                    }
                    Err(err) => return Err(err),
                };

                if snapshot.status == ProcessStatus::Running {
                    Self::refresh_bytes(entry);
                    false
                } else {
                    Self::finalize_entry(entry, snapshot.exit_code == Some(0));
                    true
                }
            };

            if should_clear_current && state.current_id.as_deref() == Some(id.as_str()) {
                state.current_id = None;
            }
        }

        Ok(())
    }

    fn refresh_bytes(entry: &mut RecordingEntry) {
        entry.info.bytes = file_size(&entry.path);
    }

    fn finalize_entry(entry: &mut RecordingEntry, success: bool) {
        let bytes = file_size(&entry.path);
        entry.info.status = if success || (entry.path.is_file() && bytes > 0) {
            DesktopRecordingStatus::Completed
        } else {
            DesktopRecordingStatus::Failed
        };
        entry
            .info
            .ended_at
            .get_or_insert_with(|| chrono::Utc::now().to_rfc3339());
        entry.info.bytes = bytes;
    }
}

fn find_binary(name: &str) -> Option<PathBuf> {
    let path_env = std::env::var_os("PATH")?;
    for path in std::env::split_paths(&path_env) {
        let candidate = path.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn file_size(path: &Path) -> u64 {
    fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}
