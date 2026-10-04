/// Integration tests that verify all software documented in docs/common-software.mdx
/// is installed and working inside the sandbox.
///
/// These tests use `docker/test-common-software/Dockerfile` which extends the base
/// test-agent image with all documented software pre-installed.
///
/// KEEP IN SYNC with docs/common-software.mdx and docker/test-common-software/Dockerfile.
///
/// Run with:
///   cargo test -p sandbox-agent --test common_software
use reqwest::header::HeaderMap;
use reqwest::{Method, StatusCode};
use serde_json::{json, Value};
use serial_test::serial;

#[path = "support/docker_common_software.rs"]
mod docker_support;
use docker_support::TestApp;

async fn send_request(
    app: &docker_support::DockerApp,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let client = reqwest::Client::new();
    let mut builder = client.request(method, app.http_url(uri));

    let response = if let Some(body) = body {
        builder = builder.header("content-type", "application/json");
        builder
            .body(body.to_string())
            .send()
            .await
            .expect("request")
    } else {
        builder.send().await.expect("request")
    };
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.bytes().await.expect("body");
    (status, headers, bytes.to_vec())
}

fn parse_json(bytes: &[u8]) -> Value {
    if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(bytes).expect("valid json")
    }
}

/// Run a command inside the sandbox and assert it exits with code 0.
/// Returns the parsed JSON response.
async fn run_ok(app: &docker_support::DockerApp, command: &str, args: &[&str]) -> Value {
    run_ok_with_timeout(app, command, args, 30_000).await
}

async fn run_ok_with_timeout(
    app: &docker_support::DockerApp,
    command: &str,
    args: &[&str],
    timeout_ms: u64,
) -> Value {
    let (status, _, body) = send_request(
        app,
        Method::POST,
        "/v1/processes/run",
        Some(json!({
            "command": command,
            "args": args,
            "timeoutMs": timeout_ms
        })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "run {command} failed: {}",
        String::from_utf8_lossy(&body)
    );
    let parsed = parse_json(&body);
    assert_eq!(
        parsed["exitCode"], 0,
        "{command} exited with non-zero code.\nstdout: {}\nstderr: {}",
        parsed["stdout"], parsed["stderr"]
    );
    parsed
}

// ---------------------------------------------------------------------------
// Browsers
// ---------------------------------------------------------------------------

#[tokio::test]
#[serial]
async fn chromium_is_installed_and_runs() {
    let test_app = TestApp::new();
    let result = run_ok(&test_app.app, "chromium", &["--version"]).await;
    let stdout = result["stdout"].as_str().unwrap_or("");
    assert!(
        stdout.contains("Chromium"),
        "expected Chromium version string, got: {stdout}"
    );
}

#[tokio::test]
#[serial]
async fn firefox_esr_is_installed_and_runs() {
    let test_app = TestApp::new();
    let result = run_ok(&test_app.app, "firefox-esr", &["--version"]).await;
    let stdout = result["stdout"].as_str().unwrap_or("");
    assert!(
        stdout.contains("Mozilla Firefox"),
        "expected Firefox version string, got: {stdout}"
    );
}

// ---------------------------------------------------------------------------
// Languages and runtimes
// ---------------------------------------------------------------------------

#[tokio::test]
#[serial]
async fn nodejs_is_installed_and_runs() {
    let test_app = TestApp::new();
    let result = run_ok(&test_app.app, "node", &["--version"]).await;
    let stdout = result["stdout"].as_str().unwrap_or("");
    assert!(
        stdout.starts_with('v'),
        "expected node version string, got: {stdout}"
    );
}

#[tokio::test]
#[serial]
async fn npm_is_installed() {
    let test_app = TestApp::new();
    run_ok(&test_app.app, "npm", &["--version"]).await;
}

#[tokio::test]
#[serial]
async fn python3_is_installed_and_runs() {
    let test_app = TestApp::new();
    let result = run_ok(&test_app.app, "python3", &["--version"]).await;
    let stdout = result["stdout"].as_str().unwrap_or("");
    assert!(
        stdout.contains("Python 3"),
        "expected Python version string, got: {stdout}"
    );
}

#[tokio::test]
#[serial]
async fn pip3_is_installed() {
    let test_app = TestApp::new();
    run_ok(&test_app.app, "pip3", &["--version"]).await;
}

#[tokio::test]
#[serial]
async fn java_is_installed_and_runs() {
    let test_app = TestApp::new();
    // java --version prints to stdout on modern JDKs
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/processes/run",
        Some(json!({
            "command": "java",
            "args": ["--version"],
            "timeoutMs": 30000
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    assert_eq!(parsed["exitCode"], 0);
    let combined = format!(
        "{}{}",
        parsed["stdout"].as_str().unwrap_or(""),
        parsed["stderr"].as_str().unwrap_or("")
    );
    assert!(
        combined.contains("openjdk") || combined.contains("OpenJDK") || combined.contains("java"),
        "expected Java version string, got: {combined}"
    );
}

#[tokio::test]
#[serial]
async fn ruby_is_installed_and_runs() {
    let test_app = TestApp::new();
    let result = run_ok(&test_app.app, "ruby", &["--version"]).await;
    let stdout = result["stdout"].as_str().unwrap_or("");
    assert!(
        stdout.contains("ruby"),
        "expected Ruby version string, got: {stdout}"
    );
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

#[tokio::test]
#[serial]
async fn sqlite3_is_installed_and_runs() {
    let test_app = TestApp::new();
    let result = run_ok(&test_app.app, "sqlite3", &["--version"]).await;
    let stdout = result["stdout"].as_str().unwrap_or("");
    assert!(!stdout.is_empty(), "expected sqlite3 version output");
}

#[tokio::test]
#[serial]
async fn redis_server_is_installed() {
    let test_app = TestApp::new();
    let result = run_ok(&test_app.app, "redis-server", &["--version"]).await;
    let stdout = result["stdout"].as_str().unwrap_or("");
    assert!(
        stdout.contains("Redis") || stdout.contains("redis"),
        "expected Redis version string, got: {stdout}"
    );
}

// ---------------------------------------------------------------------------
// Build tools
// ---------------------------------------------------------------------------

#[tokio::test]
#[serial]
async fn gcc_is_installed() {
    let test_app = TestApp::new();
    run_ok(&test_app.app, "gcc", &["--version"]).await;
}

#[tokio::test]
#[serial]
async fn make_is_installed() {
    let test_app = TestApp::new();
    run_ok(&test_app.app, "make", &["--version"]).await;
}

#[tokio::test]
#[serial]
async fn cmake_is_installed() {
    let test_app = TestApp::new();
    run_ok(&test_app.app, "cmake", &["--version"]).await;
}

#[tokio::test]
#[serial]
async fn pkg_config_is_installed() {
    let test_app = TestApp::new();
    run_ok(&test_app.app, "pkg-config", &["--version"]).await;
}

// ---------------------------------------------------------------------------
// CLI tools
// ---------------------------------------------------------------------------

#[tokio::test]
#[serial]
async fn git_is_installed_and_runs() {
    let test_app = TestApp::new();
    let result = run_ok(&test_app.app, "git", &["--version"]).await;
    let stdout = result["stdout"].as_str().unwrap_or("");
    assert!(
        stdout.contains("git version"),
        "expected git version string, got: {stdout}"
    );
}

#[tokio::test]
#[serial]
async fn jq_is_installed_and_runs() {
    let test_app = TestApp::new();
    // Pipe a simple JSON through jq
    let result = run_ok(&test_app.app, "sh", &["-c", "echo '{\"a\":1}' | jq '.a'"]).await;
    let stdout = result["stdout"].as_str().unwrap_or("").trim();
    assert_eq!(stdout, "1", "jq did not parse JSON correctly: {stdout}");
}

#[tokio::test]
#[serial]
async fn tmux_is_installed() {
    let test_app = TestApp::new();
    run_ok(&test_app.app, "tmux", &["-V"]).await;
}

// ---------------------------------------------------------------------------
// Media and graphics
// ---------------------------------------------------------------------------

#[tokio::test]
#[serial]
async fn ffmpeg_is_installed_and_runs() {
    let test_app = TestApp::new();
    // ffmpeg prints version to stderr, so just check exit code via -version
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/processes/run",
        Some(json!({
            "command": "ffmpeg",
            "args": ["-version"],
            "timeoutMs": 10000
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    assert_eq!(parsed["exitCode"], 0);
    let combined = format!(
        "{}{}",
        parsed["stdout"].as_str().unwrap_or(""),
        parsed["stderr"].as_str().unwrap_or("")
    );
    assert!(
        combined.contains("ffmpeg version"),
        "expected ffmpeg version string, got: {combined}"
    );
}

#[tokio::test]
#[serial]
async fn imagemagick_is_installed() {
    let test_app = TestApp::new();
    run_ok(&test_app.app, "convert", &["--version"]).await;
}

#[tokio::test]
#[serial]
async fn poppler_pdftoppm_is_installed() {
    let test_app = TestApp::new();
    // pdftoppm -v prints to stderr and exits 0
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/processes/run",
        Some(json!({
            "command": "pdftoppm",
            "args": ["-v"],
            "timeoutMs": 10000
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    assert_eq!(parsed["exitCode"], 0);
}

// ---------------------------------------------------------------------------
// Desktop applications (verify binary exists, don't launch GUI)
// ---------------------------------------------------------------------------

#[tokio::test]
#[serial]
async fn gimp_is_installed() {
    let test_app = TestApp::new();
    let result = run_ok(&test_app.app, "gimp", &["--version"]).await;
    let stdout = result["stdout"].as_str().unwrap_or("");
    assert!(
        stdout.contains("GIMP") || stdout.contains("gimp") || stdout.contains("Image Manipulation"),
        "expected GIMP version string, got: {stdout}"
    );
}

// ---------------------------------------------------------------------------
// Functional tests: verify tools actually work, not just that they're present
// ---------------------------------------------------------------------------

#[tokio::test]
#[serial]
async fn python3_can_run_script() {
    let test_app = TestApp::new();
    let result = run_ok(
        &test_app.app,
        "python3",
        &["-c", "import json; print(json.dumps({'ok': True}))"],
    )
    .await;
    let stdout = result["stdout"].as_str().unwrap_or("").trim();
    let parsed: Value = serde_json::from_str(stdout).expect("python json output");
    assert_eq!(parsed["ok"], true);
}

#[tokio::test]
#[serial]
async fn node_can_run_script() {
    let test_app = TestApp::new();
    let result = run_ok(
        &test_app.app,
        "node",
        &["-e", "console.log(JSON.stringify({ok: true}))"],
    )
    .await;
    let stdout = result["stdout"].as_str().unwrap_or("").trim();
    let parsed: Value = serde_json::from_str(stdout).expect("node json output");
    assert_eq!(parsed["ok"], true);
}

#[tokio::test]
#[serial]
async fn ruby_can_run_script() {
    let test_app = TestApp::new();
    let result = run_ok(
        &test_app.app,
        "ruby",
        &["-e", "require 'json'; puts JSON.generate({ok: true})"],
    )
    .await;
    let stdout = result["stdout"].as_str().unwrap_or("").trim();
    let parsed: Value = serde_json::from_str(stdout).expect("ruby json output");
    assert_eq!(parsed["ok"], true);
}

#[tokio::test]
#[serial]
async fn gcc_can_compile_and_run_hello_world() {
    let test_app = TestApp::new();

    // Write a C file
    run_ok(
        &test_app.app,
        "sh",
        &["-c", r#"printf '#include <stdio.h>\nint main(){printf("hello\\n");return 0;}\n' > /tmp/hello.c"#],
    )
    .await;

    // Compile it
    run_ok(&test_app.app, "gcc", &["-o", "/tmp/hello", "/tmp/hello.c"]).await;

    // Run it
    let result = run_ok(&test_app.app, "/tmp/hello", &[]).await;
    let stdout = result["stdout"].as_str().unwrap_or("").trim();
    assert_eq!(stdout, "hello");
}

#[tokio::test]
#[serial]
async fn sqlite3_can_create_and_query() {
    let test_app = TestApp::new();
    let result = run_ok(
        &test_app.app,
        "sh",
        &[
            "-c",
            "sqlite3 /tmp/test.db 'CREATE TABLE t(v TEXT); INSERT INTO t VALUES(\"ok\"); SELECT v FROM t;'",
        ],
    )
    .await;
    let stdout = result["stdout"].as_str().unwrap_or("").trim();
    assert_eq!(stdout, "ok");
}

#[tokio::test]
#[serial]
async fn git_can_init_and_commit() {
    let test_app = TestApp::new();
    run_ok(
        &test_app.app,
        "sh",
        &[
            "-c",
            "cd /tmp && mkdir -p testrepo && cd testrepo && git init && git config user.email 'test@test.com' && git config user.name 'Test' && touch file && git add file && git commit -m 'init'",
        ],
    )
    .await;
}

#[tokio::test]
#[serial]
async fn chromium_headless_can_dump_dom() {
    let test_app = TestApp::new();
    // Use headless mode to dump the DOM of a blank page
    let result = run_ok_with_timeout(
        &test_app.app,
        "chromium",
        &[
            "--headless",
            "--no-sandbox",
            "--disable-gpu",
            "--dump-dom",
            "data:text/html,<h1>hello</h1>",
        ],
        30_000,
    )
    .await;
    let stdout = result["stdout"].as_str().unwrap_or("");
    assert!(
        stdout.contains("hello"),
        "expected hello in DOM dump, got: {stdout}"
    );
}
