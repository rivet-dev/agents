use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sandbox_agent::router::AuthConfig;
use serial_test::serial;
use tempfile::TempDir;

const CONTAINER_PORT: u16 = 3000;
const DEFAULT_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DEFAULT_IMAGE_TAG: &str = "sandbox-agent-test:dev";
const STANDARD_PATHS: &[&str] = &[
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
];

static IMAGE_TAG: OnceLock<String> = OnceLock::new();
static DOCKER_BIN: OnceLock<PathBuf> = OnceLock::new();
static CONTAINER_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
pub struct DockerApp {
    base_url: String,
}

impl DockerApp {
    pub fn http_url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    pub fn ws_url(&self, path: &str) -> String {
        let suffix = self
            .base_url
            .strip_prefix("http://")
            .unwrap_or(&self.base_url);
        format!("ws://{suffix}{path}")
    }
}

pub struct TestApp {
    pub app: DockerApp,
    install_dir: PathBuf,
    _root: TempDir,
    container_id: String,
}

#[derive(Default)]
pub struct TestAppOptions {
    pub env: BTreeMap<String, String>,
    pub extra_paths: Vec<PathBuf>,
    pub replace_path: bool,
}

impl TestApp {
    pub fn new(auth: AuthConfig) -> Self {
        Self::with_setup(auth, |_| {})
    }

    pub fn with_setup<F>(auth: AuthConfig, setup: F) -> Self
    where
        F: FnOnce(&Path),
    {
        Self::with_options(auth, TestAppOptions::default(), setup)
    }

    pub fn with_options<F>(auth: AuthConfig, options: TestAppOptions, setup: F) -> Self
    where
        F: FnOnce(&Path),
    {
        let root = tempfile::tempdir().expect("create docker test root");
        let layout = TestLayout::new(root.path());
        layout.create();
        setup(&layout.install_dir);

        let container_id = unique_container_id();
        let image = ensure_test_image();
        let env = build_env(&layout, &auth, &options);
        let mounts = build_mounts(root.path(), &env);
        let base_url = run_container(&container_id, &image, &mounts, &env, &auth);

        Self {
            app: DockerApp { base_url },
            install_dir: layout.install_dir,
            _root: root,
            container_id,
        }
    }

    pub fn install_path(&self) -> &Path {
        &self.install_dir
    }

    pub fn root_path(&self) -> &Path {
        self._root.path()
    }
}

impl Drop for TestApp {
    fn drop(&mut self) {
        let _ = Command::new(docker_bin())
            .args(["rm", "-f", &self.container_id])
            .output();
    }
}

pub struct LiveServer {
    base_url: String,
}

impl LiveServer {
    pub async fn spawn(app: DockerApp) -> Self {
        Self {
            base_url: app.base_url,
        }
    }

    pub fn http_url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    pub fn ws_url(&self, path: &str) -> String {
        let suffix = self
            .base_url
            .strip_prefix("http://")
            .unwrap_or(&self.base_url);
        format!("ws://{suffix}{path}")
    }

    pub async fn shutdown(self) {}
}

struct TestLayout {
    home: PathBuf,
    xdg_data_home: PathBuf,
    xdg_state_home: PathBuf,
    appdata: PathBuf,
    local_appdata: PathBuf,
    install_dir: PathBuf,
}

impl TestLayout {
    fn new(root: &Path) -> Self {
        let home = root.join("home");
        let xdg_data_home = root.join("xdg-data");
        let xdg_state_home = root.join("xdg-state");
        let appdata = root.join("appdata").join("Roaming");
        let local_appdata = root.join("appdata").join("Local");
        let install_dir = xdg_data_home.join("sandbox-agent").join("bin");
        Self {
            home,
            xdg_data_home,
            xdg_state_home,
            appdata,
            local_appdata,
            install_dir,
        }
    }

    fn create(&self) {
        for dir in [
            &self.home,
            &self.xdg_data_home,
            &self.xdg_state_home,
            &self.appdata,
            &self.local_appdata,
            &self.install_dir,
        ] {
            fs::create_dir_all(dir).expect("create docker test dir");
        }
    }
}

fn ensure_test_image() -> String {
    IMAGE_TAG
        .get_or_init(|| {
            let repo_root = repo_root();
            let image_tag = std::env::var("SANDBOX_AGENT_TEST_IMAGE")
                .unwrap_or_else(|_| DEFAULT_IMAGE_TAG.to_string());
            let output = Command::new(docker_bin())
                .args(["build", "--tag", &image_tag, "--file"])
                .arg(
                    repo_root
                        .join("docker")
                        .join("test-agent")
                        .join("Dockerfile"),
                )
                .arg(&repo_root)
                .output()
                .expect("build sandbox-agent test image");
            if !output.status.success() {
                panic!(
                    "failed to build sandbox-agent test image: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            image_tag
        })
        .clone()
}

fn build_env(
    layout: &TestLayout,
    auth: &AuthConfig,
    options: &TestAppOptions,
) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    env.insert(
        "HOME".to_string(),
        layout.home.to_string_lossy().to_string(),
    );
    env.insert(
        "USERPROFILE".to_string(),
        layout.home.to_string_lossy().to_string(),
    );
    env.insert(
        "XDG_DATA_HOME".to_string(),
        layout.xdg_data_home.to_string_lossy().to_string(),
    );
    env.insert(
        "XDG_STATE_HOME".to_string(),
        layout.xdg_state_home.to_string_lossy().to_string(),
    );
    env.insert(
        "APPDATA".to_string(),
        layout.appdata.to_string_lossy().to_string(),
    );
    env.insert(
        "LOCALAPPDATA".to_string(),
        layout.local_appdata.to_string_lossy().to_string(),
    );

    for (key, value) in std::env::vars() {
        if key == "PATH" {
            continue;
        }
        if key == "XDG_STATE_HOME" || key == "HOME" || key == "USERPROFILE" {
            continue;
        }
        if key.starts_with("SANDBOX_AGENT_") || key.starts_with("OPENCODE_COMPAT_") {
            env.insert(key.clone(), rewrite_localhost_url(&key, &value));
        }
    }

    if let Some(token) = auth.token.as_ref() {
        env.insert("SANDBOX_AGENT_TEST_AUTH_TOKEN".to_string(), token.clone());
    }

    if options.replace_path {
        env.insert(
            "PATH".to_string(),
            options.env.get("PATH").cloned().unwrap_or_default(),
        );
    } else {
        let mut custom_path_entries =
            custom_path_entries(layout.install_dir.parent().expect("install base"));
        custom_path_entries.extend(explicit_path_entries());
        custom_path_entries.extend(
            options
                .extra_paths
                .iter()
                .filter(|path| path.is_absolute() && path.exists())
                .cloned(),
        );
        custom_path_entries.sort();
        custom_path_entries.dedup();

        if custom_path_entries.is_empty() {
            env.insert("PATH".to_string(), DEFAULT_PATH.to_string());
        } else {
            let joined = custom_path_entries
                .iter()
                .map(|path| path.to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join(":");
            env.insert("PATH".to_string(), format!("{joined}:{DEFAULT_PATH}"));
        }
    }

    for (key, value) in &options.env {
        if key == "PATH" {
            continue;
        }
        env.insert(key.clone(), rewrite_localhost_url(key, value));
    }

    env
}

fn build_mounts(root: &Path, env: &BTreeMap<String, String>) -> Vec<PathBuf> {
    let mut mounts = BTreeSet::new();
    mounts.insert(root.to_path_buf());

    for key in [
        "HOME",
        "USERPROFILE",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "APPDATA",
        "LOCALAPPDATA",
        "SANDBOX_AGENT_DESKTOP_FAKE_STATE_DIR",
    ] {
        if let Some(value) = env.get(key) {
            let path = PathBuf::from(value);
            if path.is_absolute() {
                mounts.insert(path);
            }
        }
    }

    if let Some(path_value) = env.get("PATH") {
        for entry in path_value.split(':') {
            if entry.is_empty() || STANDARD_PATHS.contains(&entry) {
                continue;
            }
            let path = PathBuf::from(entry);
            if path.is_absolute() && path.exists() {
                mounts.insert(path);
            }
        }
    }

    mounts.into_iter().collect()
}

fn run_container(
    container_id: &str,
    image: &str,
    mounts: &[PathBuf],
    env: &BTreeMap<String, String>,
    auth: &AuthConfig,
) -> String {
    let mut args = vec![
        "run".to_string(),
        "-d".to_string(),
        "--rm".to_string(),
        "--name".to_string(),
        container_id.to_string(),
        "-p".to_string(),
        format!("127.0.0.1::{CONTAINER_PORT}"),
    ];

    #[cfg(unix)]
    {
        args.push("--user".to_string());
        args.push(format!("{}:{}", unsafe { libc::geteuid() }, unsafe {
            libc::getegid()
        }));
    }

    if cfg!(target_os = "linux") {
        args.push("--add-host".to_string());
        args.push("host.docker.internal:host-gateway".to_string());
    }

    for mount in mounts {
        args.push("-v".to_string());
        args.push(format!("{}:{}", mount.display(), mount.display()));
    }

    for (key, value) in env {
        args.push("-e".to_string());
        args.push(format!("{key}={value}"));
    }

    args.push(image.to_string());
    args.push("server".to_string());
    args.push("--host".to_string());
    args.push("0.0.0.0".to_string());
    args.push("--port".to_string());
    args.push(CONTAINER_PORT.to_string());
    match auth.token.as_ref() {
        Some(token) => {
            args.push("--token".to_string());
            args.push(token.clone());
        }
        None => args.push("--no-token".to_string()),
    }

    let output = Command::new(docker_bin())
        .args(&args)
        .output()
        .expect("start docker test container");
    if !output.status.success() {
        panic!(
            "failed to start docker test container: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let port_output = Command::new(docker_bin())
        .args(["port", container_id, &format!("{CONTAINER_PORT}/tcp")])
        .output()
        .expect("resolve mapped docker port");
    if !port_output.status.success() {
        panic!(
            "failed to resolve docker test port: {}",
            String::from_utf8_lossy(&port_output.stderr)
        );
    }

    let mapping = String::from_utf8(port_output.stdout)
        .expect("docker port utf8")
        .trim()
        .to_string();
    let host_port = mapping.rsplit(':').next().expect("mapped host port").trim();
    let base_url = format!("http://127.0.0.1:{host_port}");
    wait_for_health(&base_url, auth.token.as_deref());
    base_url
}

fn wait_for_health(base_url: &str, token: Option<&str>) {
    let started = SystemTime::now();
    loop {
        if probe_health(base_url, token) {
            return;
        }

        if started
            .elapsed()
            .unwrap_or_else(|_| Duration::from_secs(0))
            .gt(&Duration::from_secs(30))
        {
            panic!("timed out waiting for sandbox-agent docker test server");
        }
        thread::sleep(Duration::from_millis(200));
    }
}

fn probe_health(base_url: &str, token: Option<&str>) -> bool {
    let address = base_url.strip_prefix("http://").unwrap_or(base_url);
    let mut stream = match TcpStream::connect(address) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));

    let mut request =
        format!("GET /v1/health HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n");
    if let Some(token) = token {
        request.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    request.push_str("\r\n");

    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }

    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
}

fn custom_path_entries(root: &Path) -> Vec<PathBuf> {
    let mut entries = Vec::new();
    if let Some(value) = std::env::var_os("PATH") {
        for entry in std::env::split_paths(&value) {
            if !entry.exists() {
                continue;
            }
            if entry.starts_with(root) || entry.starts_with(std::env::temp_dir()) {
                entries.push(entry);
            }
        }
    }
    entries.sort();
    entries.dedup();
    entries
}

fn explicit_path_entries() -> Vec<PathBuf> {
    let mut entries = Vec::new();
    if let Some(value) = std::env::var_os("SANDBOX_AGENT_TEST_EXTRA_PATHS") {
        for entry in std::env::split_paths(&value) {
            if entry.is_absolute() && entry.exists() {
                entries.push(entry);
            }
        }
    }
    entries
}

fn rewrite_localhost_url(key: &str, value: &str) -> String {
    if key.ends_with("_URL") || key.ends_with("_URI") {
        return value
            .replace("http://127.0.0.1", "http://host.docker.internal")
            .replace("http://localhost", "http://host.docker.internal");
    }
    value.to_string()
}

fn unique_container_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let counter = CONTAINER_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(
        "sandbox-agent-test-{}-{millis}-{counter}",
        std::process::id()
    )
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("repo root")
}

fn docker_bin() -> &'static Path {
    DOCKER_BIN
        .get_or_init(|| {
            if let Some(value) = std::env::var_os("SANDBOX_AGENT_TEST_DOCKER_BIN") {
                let path = PathBuf::from(value);
                if path.exists() {
                    return path;
                }
            }

            for candidate in [
                "/usr/local/bin/docker",
                "/opt/homebrew/bin/docker",
                "/usr/bin/docker",
            ] {
                let path = PathBuf::from(candidate);
                if path.exists() {
                    return path;
                }
            }

            PathBuf::from("docker")
        })
        .as_path()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EnvVarGuard {
        key: &'static str,
        old: Option<std::ffi::OsString>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &Path) -> Self {
            let old = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, old }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match self.old.as_ref() {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    #[test]
    #[serial]
    fn build_env_keeps_test_local_xdg_state_home() {
        let root = tempfile::tempdir().expect("create docker support tempdir");
        let host_state = tempfile::tempdir().expect("create host xdg state tempdir");
        let _guard = EnvVarGuard::set("XDG_STATE_HOME", host_state.path());

        let layout = TestLayout::new(root.path());
        layout.create();

        let env = build_env(&layout, &AuthConfig::disabled(), &TestAppOptions::default());
        assert_eq!(
            env.get("XDG_STATE_HOME"),
            Some(&layout.xdg_state_home.to_string_lossy().to_string())
        );
    }
}
