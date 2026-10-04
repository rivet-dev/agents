/// Docker support for common-software integration tests.
///
/// Builds the `docker/test-common-software/Dockerfile` image (which extends the
/// base test-agent image with pre-installed common software) and provides a
/// `TestApp` that runs a container from it.
///
/// KEEP IN SYNC with docs/common-software.mdx and docker/test-common-software/Dockerfile.
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tempfile::TempDir;

const CONTAINER_PORT: u16 = 3000;
const DEFAULT_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const BASE_IMAGE_TAG: &str = "sandbox-agent-test:dev";
const COMMON_SOFTWARE_IMAGE_TAG: &str = "sandbox-agent-test-common-software:dev";

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
}

pub struct TestApp {
    pub app: DockerApp,
    _root: TempDir,
    container_id: String,
}

impl TestApp {
    pub fn new() -> Self {
        let root = tempfile::tempdir().expect("create docker test root");
        let layout = TestLayout::new(root.path());
        layout.create();

        let container_id = unique_container_id();
        let image = ensure_common_software_image();
        let env = build_env(&layout);
        let mounts = build_mounts(root.path());
        let base_url = run_container(&container_id, &image, &mounts, &env);

        Self {
            app: DockerApp { base_url },
            _root: root,
            container_id,
        }
    }
}

impl Drop for TestApp {
    fn drop(&mut self) {
        let _ = Command::new(docker_bin())
            .args(["rm", "-f", &self.container_id])
            .output();
    }
}

struct TestLayout {
    home: PathBuf,
    xdg_data_home: PathBuf,
    xdg_state_home: PathBuf,
}

impl TestLayout {
    fn new(root: &Path) -> Self {
        Self {
            home: root.join("home"),
            xdg_data_home: root.join("xdg-data"),
            xdg_state_home: root.join("xdg-state"),
        }
    }

    fn create(&self) {
        for dir in [&self.home, &self.xdg_data_home, &self.xdg_state_home] {
            std::fs::create_dir_all(dir).expect("create docker test dir");
        }
    }
}

fn ensure_base_image() -> String {
    let repo_root = repo_root();
    let image_tag =
        std::env::var("SANDBOX_AGENT_TEST_IMAGE").unwrap_or_else(|_| BASE_IMAGE_TAG.to_string());
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
        .expect("build base test image");
    if !output.status.success() {
        panic!(
            "failed to build base test image: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    image_tag
}

fn ensure_common_software_image() -> String {
    IMAGE_TAG
        .get_or_init(|| {
            let base_image = ensure_base_image();
            let repo_root = repo_root();
            let image_tag = std::env::var("SANDBOX_AGENT_TEST_COMMON_SOFTWARE_IMAGE")
                .unwrap_or_else(|_| COMMON_SOFTWARE_IMAGE_TAG.to_string());
            let output = Command::new(docker_bin())
                .args([
                    "build",
                    "--tag",
                    &image_tag,
                    "--build-arg",
                    &format!("BASE_IMAGE={base_image}"),
                    "--file",
                ])
                .arg(
                    repo_root
                        .join("docker")
                        .join("test-common-software")
                        .join("Dockerfile"),
                )
                .arg(&repo_root)
                .output()
                .expect("build common-software test image");
            if !output.status.success() {
                panic!(
                    "failed to build common-software test image: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            image_tag
        })
        .clone()
}

fn build_env(layout: &TestLayout) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    env.insert(
        "HOME".to_string(),
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
    env.insert("PATH".to_string(), DEFAULT_PATH.to_string());
    env
}

fn build_mounts(root: &Path) -> Vec<PathBuf> {
    vec![root.to_path_buf()]
}

fn run_container(
    container_id: &str,
    image: &str,
    mounts: &[PathBuf],
    env: &BTreeMap<String, String>,
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
    args.push("--no-token".to_string());

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
    wait_for_health(&base_url);
    base_url
}

fn wait_for_health(base_url: &str) {
    let started = SystemTime::now();
    loop {
        if probe_health(base_url) {
            return;
        }
        if started
            .elapsed()
            .unwrap_or_else(|_| Duration::from_secs(0))
            .gt(&Duration::from_secs(60))
        {
            panic!("timed out waiting for common-software docker test server");
        }
        thread::sleep(Duration::from_millis(200));
    }
}

fn probe_health(base_url: &str) -> bool {
    let address = base_url.strip_prefix("http://").unwrap_or(base_url);
    let mut stream = match TcpStream::connect(address) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));

    let request =
        format!("GET /v1/health HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }

    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
}

fn unique_container_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let counter = CONTAINER_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(
        "sandbox-agent-common-sw-{}-{millis}-{counter}",
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
