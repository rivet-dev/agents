use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let root_dir = manifest_dir
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .expect("workspace root");
    let dist_dir = root_dir
        .join("frontend")
        .join("packages")
        .join("inspector")
        .join("dist");
    let inspector_pkg_dir = root_dir.join("frontend").join("packages").join("inspector");

    println!("cargo:rerun-if-env-changed=SANDBOX_AGENT_SKIP_INSPECTOR");
    println!("cargo:rerun-if-env-changed=SANDBOX_AGENT_VERSION");
    // Watch the inspector package directory so Cargo reruns when dist appears/disappears.
    println!("cargo:rerun-if-changed={}", inspector_pkg_dir.display());
    let dist_exists = dist_dir.exists();
    if dist_exists {
        println!("cargo:rerun-if-changed={}", dist_dir.display());
    } else {
        println!(
            "cargo:warning=Inspector frontend missing at {}. Embedding disabled; set SANDBOX_AGENT_SKIP_INSPECTOR=1 to silence or build the inspector to embed it.",
            dist_dir.display()
        );
    }

    // Rebuild when the git HEAD changes so BUILD_ID stays current.
    let git_head = manifest_dir.join(".git/HEAD");
    if git_head.exists() {
        println!("cargo:rerun-if-changed={}", git_head.display());
    } else {
        // In a workspace the .git dir lives at the repo root.
        let root_git_head = root_dir.join(".git/HEAD");
        if root_git_head.exists() {
            println!("cargo:rerun-if-changed={}", root_git_head.display());
        }
    }

    // Generate version constant from environment variable or fallback to Cargo.toml version
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    generate_version(&out_dir);
    generate_build_id(&out_dir);

    let skip = env::var("SANDBOX_AGENT_SKIP_INSPECTOR").is_ok() || !dist_exists;
    let out_file = out_dir.join("inspector_assets.rs");

    if skip {
        write_disabled(&out_file);
        return;
    }

    let dist_literal = quote_path(&dist_dir);
    let contents = format!(
        "pub const INSPECTOR_ENABLED: bool = true;\n\
         pub fn inspector_dir() -> Option<&'static include_dir::Dir<'static>> {{\n\
             Some(&INSPECTOR_DIR)\n\
         }}\n\
         static INSPECTOR_DIR: include_dir::Dir<'static> = include_dir::include_dir!(\"{}\");\n",
        dist_literal
    );

    fs::write(&out_file, contents).expect("write inspector_assets.rs");
}

fn write_disabled(out_file: &Path) {
    let contents = "pub const INSPECTOR_ENABLED: bool = false;\n\
        pub fn inspector_dir() -> Option<&'static include_dir::Dir<'static>> {\n\
            None\n\
        }\n";
    fs::write(out_file, contents).expect("write inspector_assets.rs");
}

fn quote_path(path: &Path) -> String {
    path.to_str()
        .expect("valid path")
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

fn generate_version(out_dir: &Path) {
    // Use SANDBOX_AGENT_VERSION env var if set, otherwise fall back to CARGO_PKG_VERSION
    let version = env::var("SANDBOX_AGENT_VERSION")
        .unwrap_or_else(|_| env::var("CARGO_PKG_VERSION").expect("CARGO_PKG_VERSION"));

    let out_file = out_dir.join("version.rs");
    let contents = format!(
        "/// Version string for this build.\n\
         /// Set via SANDBOX_AGENT_VERSION env var at build time, or falls back to Cargo.toml version.\n\
         pub const VERSION: &str = \"{}\";\n",
        version
    );

    fs::write(&out_file, contents).expect("write version.rs");
}

fn generate_build_id(out_dir: &Path) {
    use std::process::Command;

    let source_id = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| env::var("CARGO_PKG_VERSION").unwrap_or_default());
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos().to_string())
        .unwrap_or_else(|_| "0".to_string());
    let build_id = format!("{source_id}-{timestamp}");

    let out_file = out_dir.join("build_id.rs");
    let contents = format!(
        "/// Unique identifier for this build (source id + build timestamp).\n\
         pub const BUILD_ID: &str = \"{}\";\n",
        build_id
    );

    fs::write(&out_file, contents).expect("write build_id.rs");
}
