# Feature 4: Filesystem API

**Implementation approach:** Custom HTTP endpoints (not ACP), per CLAUDE.md

## Summary

v1 had 8 filesystem endpoints. v1 has only ACP `fs/read_text_file` + `fs/write_text_file` (text-only, agent->client direction). The full filesystem API should be re-implemented as Sandbox Agent-specific HTTP contracts at `/v1/fs/*`.

## Current v1 State

- ACP stable: `fs/read_text_file`, `fs/write_text_file` (client methods invoked by agents, text-only)
- No HTTP filesystem endpoints exist in current `router.rs`
- `rfds-vs-extensions.md` confirms: "Already extension (`/v1/fs/*` custom HTTP surface)"
- CLAUDE.md: "Filesystem and terminal APIs remain Sandbox Agent-specific HTTP contracts and are not ACP"

## v1 Reference (source commit)

Port behavior from commit `8ecd27bc24e62505d7aa4c50cbdd1c9dbb09f836`.

## v1 Endpoints (from `router.rs`)

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/v1/fs/entries` | `fs_entries` | List directory entries |
| GET | `/v1/fs/file` | `fs_read_file` | Read file raw bytes |
| PUT | `/v1/fs/file` | `fs_write_file` | Write file raw bytes |
| DELETE | `/v1/fs/entry` | `fs_delete_entry` | Delete file or directory |
| POST | `/v1/fs/mkdir` | `fs_mkdir` | Create directory |
| POST | `/v1/fs/move` | `fs_move` | Move/rename file or directory |
| GET | `/v1/fs/stat` | `fs_stat` | Get file/directory metadata |
| POST | `/v1/fs/upload-batch` | `fs_upload_batch` | Upload tar archive |

## v1 Types (exact, from `router.rs`)

```rust
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsPathQuery {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "session_id")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsEntriesQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "session_id")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsSessionQuery {
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "session_id")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsDeleteQuery {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "session_id")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recursive: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsUploadBatchQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "session_id")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum FsEntryType {
    File,
    Directory,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub entry_type: FsEntryType,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsStat {
    pub path: String,
    pub entry_type: FsEntryType,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsWriteResponse {
    pub path: String,
    pub bytes_written: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsMoveRequest {
    pub from: String,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overwrite: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsMoveResponse {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsActionResponse {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsUploadBatchResponse {
    pub paths: Vec<String>,
    pub truncated: bool,
}
```

## v1 Handler Implementations (exact, from `router.rs`)

### `fs_entries` (GET /v1/fs/entries)

```rust
async fn fs_entries(
    State(state): State<Arc<AppState>>,
    Query(query): Query<FsEntriesQuery>,
) -> Result<Json<Vec<FsEntry>>, ApiError> {
    let path = query.path.unwrap_or_else(|| ".".to_string());
    let target = resolve_fs_path(&state, query.session_id.as_deref(), &path).await?;
    let metadata = fs::metadata(&target).map_err(|err| map_fs_error(&target, err))?;
    if !metadata.is_dir() {
        return Err(SandboxError::InvalidRequest {
            message: format!("path is not a directory: {}", target.display()),
        }.into());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(&target).map_err(|err| map_fs_error(&target, err))? {
        let entry = entry.map_err(|err| SandboxError::StreamError { message: err.to_string() })?;
        let path = entry.path();
        let metadata = entry.metadata().map_err(|err| SandboxError::StreamError { message: err.to_string() })?;
        let entry_type = if metadata.is_dir() { FsEntryType::Directory } else { FsEntryType::File };
        let modified = metadata.modified().ok().and_then(|time| {
            chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339().into()
        });
        entries.push(FsEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: path.to_string_lossy().to_string(),
            entry_type, size: metadata.len(), modified,
        });
    }
    Ok(Json(entries))
}
```

### `fs_read_file` (GET /v1/fs/file)

```rust
async fn fs_read_file(
    State(state): State<Arc<AppState>>,
    Query(query): Query<FsPathQuery>,
) -> Result<Response, ApiError> {
    let target = resolve_fs_path(&state, query.session_id.as_deref(), &query.path).await?;
    let metadata = fs::metadata(&target).map_err(|err| map_fs_error(&target, err))?;
    if !metadata.is_file() {
        return Err(SandboxError::InvalidRequest {
            message: format!("path is not a file: {}", target.display()),
        }.into());
    }
    let bytes = fs::read(&target).map_err(|err| map_fs_error(&target, err))?;
    Ok(([(header::CONTENT_TYPE, "application/octet-stream")], Bytes::from(bytes)).into_response())
}
```

### `fs_write_file` (PUT /v1/fs/file)

```rust
async fn fs_write_file(
    State(state): State<Arc<AppState>>,
    Query(query): Query<FsPathQuery>,
    body: Bytes,
) -> Result<Json<FsWriteResponse>, ApiError> {
    let target = resolve_fs_path(&state, query.session_id.as_deref(), &query.path).await?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|err| map_fs_error(parent, err))?;
    }
    fs::write(&target, &body).map_err(|err| map_fs_error(&target, err))?;
    Ok(Json(FsWriteResponse {
        path: target.to_string_lossy().to_string(),
        bytes_written: body.len() as u64,
    }))
}
```

### `fs_delete_entry` (DELETE /v1/fs/entry)

```rust
async fn fs_delete_entry(
    State(state): State<Arc<AppState>>,
    Query(query): Query<FsDeleteQuery>,
) -> Result<Json<FsActionResponse>, ApiError> {
    let target = resolve_fs_path(&state, query.session_id.as_deref(), &query.path).await?;
    let metadata = fs::metadata(&target).map_err(|err| map_fs_error(&target, err))?;
    if metadata.is_dir() {
        if query.recursive.unwrap_or(false) {
            fs::remove_dir_all(&target).map_err(|err| map_fs_error(&target, err))?;
        } else {
            fs::remove_dir(&target).map_err(|err| map_fs_error(&target, err))?;
        }
    } else {
        fs::remove_file(&target).map_err(|err| map_fs_error(&target, err))?;
    }
    Ok(Json(FsActionResponse { path: target.to_string_lossy().to_string() }))
}
```

### `fs_mkdir` (POST /v1/fs/mkdir)

```rust
async fn fs_mkdir(
    State(state): State<Arc<AppState>>,
    Query(query): Query<FsPathQuery>,
) -> Result<Json<FsActionResponse>, ApiError> {
    let target = resolve_fs_path(&state, query.session_id.as_deref(), &query.path).await?;
    fs::create_dir_all(&target).map_err(|err| map_fs_error(&target, err))?;
    Ok(Json(FsActionResponse { path: target.to_string_lossy().to_string() }))
}
```

### `fs_move` (POST /v1/fs/move)

```rust
async fn fs_move(
    State(state): State<Arc<AppState>>,
    Query(query): Query<FsSessionQuery>,
    Json(request): Json<FsMoveRequest>,
) -> Result<Json<FsMoveResponse>, ApiError> {
    let session_id = query.session_id.as_deref();
    let from = resolve_fs_path(&state, session_id, &request.from).await?;
    let to = resolve_fs_path(&state, session_id, &request.to).await?;
    if to.exists() {
        if request.overwrite.unwrap_or(false) {
            let metadata = fs::metadata(&to).map_err(|err| map_fs_error(&to, err))?;
            if metadata.is_dir() {
                fs::remove_dir_all(&to).map_err(|err| map_fs_error(&to, err))?;
            } else {
                fs::remove_file(&to).map_err(|err| map_fs_error(&to, err))?;
            }
        } else {
            return Err(SandboxError::InvalidRequest {
                message: format!("destination already exists: {}", to.display()),
            }.into());
        }
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|err| map_fs_error(parent, err))?;
    }
    fs::rename(&from, &to).map_err(|err| map_fs_error(&from, err))?;
    Ok(Json(FsMoveResponse {
        from: from.to_string_lossy().to_string(),
        to: to.to_string_lossy().to_string(),
    }))
}
```

### `fs_stat` (GET /v1/fs/stat)

```rust
async fn fs_stat(
    State(state): State<Arc<AppState>>,
    Query(query): Query<FsPathQuery>,
) -> Result<Json<FsStat>, ApiError> {
    let target = resolve_fs_path(&state, query.session_id.as_deref(), &query.path).await?;
    let metadata = fs::metadata(&target).map_err(|err| map_fs_error(&target, err))?;
    let entry_type = if metadata.is_dir() { FsEntryType::Directory } else { FsEntryType::File };
    let modified = metadata.modified().ok().and_then(|time| {
        chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339().into()
    });
    Ok(Json(FsStat {
        path: target.to_string_lossy().to_string(),
        entry_type, size: metadata.len(), modified,
    }))
}
```

### `fs_upload_batch` (POST /v1/fs/upload-batch)

```rust
async fn fs_upload_batch(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<FsUploadBatchQuery>,
    body: Bytes,
) -> Result<Json<FsUploadBatchResponse>, ApiError> {
    let content_type = headers.get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok()).unwrap_or_default();
    if !content_type.starts_with("application/x-tar") {
        return Err(SandboxError::InvalidRequest {
            message: "content-type must be application/x-tar".to_string(),
        }.into());
    }
    let path = query.path.unwrap_or_else(|| ".".to_string());
    let base = resolve_fs_path(&state, query.session_id.as_deref(), &path).await?;
    fs::create_dir_all(&base).map_err(|err| map_fs_error(&base, err))?;

    let mut archive = Archive::new(Cursor::new(body));
    let mut extracted = Vec::new();
    let mut truncated = false;
    for entry in archive.entries().map_err(|err| SandboxError::StreamError { message: err.to_string() })? {
        let mut entry = entry.map_err(|err| SandboxError::StreamError { message: err.to_string() })?;
        let entry_path = entry.path().map_err(|err| SandboxError::StreamError { message: err.to_string() })?;
        let clean_path = sanitize_relative_path(&entry_path)?;
        if clean_path.as_os_str().is_empty() { continue; }
        let dest = base.join(&clean_path);
        if !dest.starts_with(&base) {
            return Err(SandboxError::InvalidRequest {
                message: format!("tar entry escapes destination: {}", entry_path.display()),
            }.into());
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|err| map_fs_error(parent, err))?;
        }
        entry.unpack(&dest).map_err(|err| SandboxError::StreamError { message: err.to_string() })?;
        if extracted.len() < 1024 {
            extracted.push(dest.to_string_lossy().to_string());
        } else { truncated = true; }
    }

    Ok(Json(FsUploadBatchResponse { paths: extracted, truncated }))
}
```

## Implementation Plan

### New v1 Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/fs/entries` | List directory entries |
| GET | `/v1/fs/file` | Read file raw bytes |
| PUT | `/v1/fs/file` | Write file raw bytes |
| DELETE | `/v1/fs/entry` | Delete file or directory |
| POST | `/v1/fs/mkdir` | Create directory |
| POST | `/v1/fs/move` | Move/rename |
| GET | `/v1/fs/stat` | File metadata |
| POST | `/v1/fs/upload-batch` | Upload tar archive |

### Files to Modify

| File | Change |
|------|--------|
| `server/packages/sandbox-agent/src/router.rs` | Add all 8 `/v1/fs/*` endpoints with handlers (port from v1 with v1 path prefix) |
| `server/packages/sandbox-agent/src/cli.rs` | Add CLI `fs` subcommands (list, read, write, delete, mkdir, move, stat) |
| `sdks/typescript/src/client.ts` | Add filesystem methods to SDK |
| `server/packages/sandbox-agent/tests/v1_api.rs` | Add filesystem endpoint tests |

### Docs to Update

| Doc | Change |
|-----|--------|
| `docs/openapi.json` | Add `/v1/fs/*` endpoint specs |
| `docs/cli.mdx` | Add `fs` subcommand documentation |
| `docs/sdks/typescript.mdx` | Document filesystem SDK methods |
