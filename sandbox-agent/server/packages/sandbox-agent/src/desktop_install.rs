use std::fmt;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::Command as ProcessCommand;

use clap::ValueEnum;

const AUTOMATIC_INSTALL_SUPPORTED_DISTROS: &str =
    "Automatic desktop dependency installation is supported on Debian/Ubuntu (apt), Fedora/RHEL (dnf), and Alpine (apk).";
const AUTOMATIC_INSTALL_UNSUPPORTED_ENVS: &str =
    "Automatic installation is not supported on macOS, Windows, or Linux distributions without apt, dnf, or apk.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum DesktopPackageManager {
    Apt,
    Dnf,
    Apk,
}

#[derive(Debug, Clone)]
pub struct DesktopInstallRequest {
    pub yes: bool,
    pub print_only: bool,
    pub package_manager: Option<DesktopPackageManager>,
    pub no_fonts: bool,
}

pub(crate) fn desktop_platform_support_message() -> String {
    format!("Desktop APIs are only supported on Linux. {AUTOMATIC_INSTALL_SUPPORTED_DISTROS}")
}

fn linux_install_support_message() -> String {
    format!("{AUTOMATIC_INSTALL_SUPPORTED_DISTROS} {AUTOMATIC_INSTALL_UNSUPPORTED_ENVS}")
}

pub fn install_desktop(request: DesktopInstallRequest) -> Result<(), String> {
    if std::env::consts::OS != "linux" {
        return Err(format!(
            "desktop installation is only supported on Linux. {}",
            linux_install_support_message()
        ));
    }

    let package_manager = match request.package_manager {
        Some(value) => value,
        None => detect_package_manager().ok_or_else(|| {
            format!(
                "could not detect a supported package manager. {} Install the desktop dependencies manually on this distribution.",
                linux_install_support_message()
            )
        })?,
    };

    let packages = desktop_packages(package_manager, request.no_fonts);
    let used_sudo = !running_as_root() && find_binary("sudo").is_some();
    if !running_as_root() && !used_sudo {
        return Err(
            "desktop installation requires root or sudo access; rerun as root or install dependencies manually"
                .to_string(),
        );
    }

    println!("Desktop package manager: {}", package_manager);
    println!("Desktop packages:");
    for package in &packages {
        println!("  - {package}");
    }
    println!("Install command:");
    println!(
        "  {}",
        render_install_command(package_manager, used_sudo, &packages)
    );

    if request.print_only {
        return Ok(());
    }

    if !request.yes && !prompt_yes_no("Proceed with desktop dependency installation? [y/N] ")? {
        return Err("installation cancelled".to_string());
    }

    run_install_commands(package_manager, used_sudo, &packages)?;

    println!("Desktop dependencies installed.");
    Ok(())
}

fn detect_package_manager() -> Option<DesktopPackageManager> {
    if find_binary("apt-get").is_some() {
        return Some(DesktopPackageManager::Apt);
    }
    if find_binary("dnf").is_some() {
        return Some(DesktopPackageManager::Dnf);
    }
    if find_binary("apk").is_some() {
        return Some(DesktopPackageManager::Apk);
    }
    None
}

fn desktop_packages(package_manager: DesktopPackageManager, no_fonts: bool) -> Vec<String> {
    let mut packages = match package_manager {
        DesktopPackageManager::Apt => vec![
            "xvfb",
            "openbox",
            "xdotool",
            "imagemagick",
            "ffmpeg",
            "x11-xserver-utils",
            "dbus-x11",
            "xauth",
            "fonts-dejavu-core",
        ],
        DesktopPackageManager::Dnf => vec![
            "xorg-x11-server-Xvfb",
            "openbox",
            "xdotool",
            "ImageMagick",
            "ffmpeg",
            "xrandr",
            "dbus-x11",
            "xauth",
            "dejavu-sans-fonts",
        ],
        DesktopPackageManager::Apk => vec![
            "xvfb",
            "openbox",
            "xdotool",
            "imagemagick",
            "ffmpeg",
            "xrandr",
            "dbus",
            "xauth",
            "ttf-dejavu",
        ],
    }
    .into_iter()
    .map(str::to_string)
    .collect::<Vec<_>>();

    if no_fonts {
        packages.retain(|package| {
            package != "fonts-dejavu-core"
                && package != "dejavu-sans-fonts"
                && package != "ttf-dejavu"
        });
    }

    packages
}

fn render_install_command(
    package_manager: DesktopPackageManager,
    used_sudo: bool,
    packages: &[String],
) -> String {
    let sudo = if used_sudo { "sudo " } else { "" };
    match package_manager {
        DesktopPackageManager::Apt => format!(
            "{sudo}apt-get update && {sudo}env DEBIAN_FRONTEND=noninteractive apt-get install -y {}",
            packages.join(" ")
        ),
        DesktopPackageManager::Dnf => {
            format!("{sudo}dnf install -y {}", packages.join(" "))
        }
        DesktopPackageManager::Apk => {
            format!("{sudo}apk add --no-cache {}", packages.join(" "))
        }
    }
}

fn run_install_commands(
    package_manager: DesktopPackageManager,
    used_sudo: bool,
    packages: &[String],
) -> Result<(), String> {
    match package_manager {
        DesktopPackageManager::Apt => {
            run_command(command_with_privilege(
                used_sudo,
                "apt-get",
                vec!["update".to_string()],
            ))?;
            let mut args = vec![
                "DEBIAN_FRONTEND=noninteractive".to_string(),
                "apt-get".to_string(),
                "install".to_string(),
                "-y".to_string(),
            ];
            args.extend(packages.iter().cloned());
            run_command(command_with_privilege(used_sudo, "env", args))?;
        }
        DesktopPackageManager::Dnf => {
            let mut args = vec!["install".to_string(), "-y".to_string()];
            args.extend(packages.iter().cloned());
            run_command(command_with_privilege(used_sudo, "dnf", args))?;
        }
        DesktopPackageManager::Apk => {
            let mut args = vec!["add".to_string(), "--no-cache".to_string()];
            args.extend(packages.iter().cloned());
            run_command(command_with_privilege(used_sudo, "apk", args))?;
        }
    }
    Ok(())
}

fn command_with_privilege(
    used_sudo: bool,
    program: &str,
    args: Vec<String>,
) -> (String, Vec<String>) {
    if used_sudo {
        let mut sudo_args = vec![program.to_string()];
        sudo_args.extend(args);
        ("sudo".to_string(), sudo_args)
    } else {
        (program.to_string(), args)
    }
}

fn run_command((program, args): (String, Vec<String>)) -> Result<(), String> {
    let status = ProcessCommand::new(&program)
        .args(&args)
        .status()
        .map_err(|err| format!("failed to run `{program}`: {err}"))?;
    if !status.success() {
        return Err(format!(
            "command `{}` exited with status {}",
            format_command(&program, &args),
            status
        ));
    }
    Ok(())
}

fn prompt_yes_no(prompt: &str) -> Result<bool, String> {
    print!("{prompt}");
    io::stdout()
        .flush()
        .map_err(|err| format!("failed to flush prompt: {err}"))?;
    let mut input = String::new();
    io::stdin()
        .read_line(&mut input)
        .map_err(|err| format!("failed to read confirmation: {err}"))?;
    let normalized = input.trim().to_ascii_lowercase();
    Ok(matches!(normalized.as_str(), "y" | "yes"))
}

fn running_as_root() -> bool {
    #[cfg(unix)]
    unsafe {
        return libc::geteuid() == 0;
    }
    #[cfg(not(unix))]
    {
        false
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

fn format_command(program: &str, args: &[String]) -> String {
    let mut parts = vec![program.to_string()];
    parts.extend(args.iter().cloned());
    parts.join(" ")
}

impl fmt::Display for DesktopPackageManager {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DesktopPackageManager::Apt => write!(f, "apt"),
            DesktopPackageManager::Dnf => write!(f, "dnf"),
            DesktopPackageManager::Apk => write!(f, "apk"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_platform_support_message_mentions_linux_and_supported_distros() {
        let message = desktop_platform_support_message();
        assert!(message.contains("only supported on Linux"));
        assert!(message.contains("Debian/Ubuntu (apt)"));
        assert!(message.contains("Fedora/RHEL (dnf)"));
        assert!(message.contains("Alpine (apk)"));
    }

    #[test]
    fn linux_install_support_message_mentions_unsupported_environments() {
        let message = linux_install_support_message();
        assert!(message.contains("Debian/Ubuntu (apt)"));
        assert!(message.contains("Fedora/RHEL (dnf)"));
        assert!(message.contains("Alpine (apk)"));
        assert!(message.contains("macOS"));
        assert!(message.contains("Windows"));
        assert!(message.contains("without apt, dnf, or apk"));
    }

    #[test]
    fn desktop_packages_support_no_fonts() {
        let packages = desktop_packages(DesktopPackageManager::Apt, true);
        assert!(!packages.iter().any(|value| value == "fonts-dejavu-core"));
        assert!(packages.iter().any(|value| value == "xvfb"));
    }

    #[test]
    fn render_install_command_matches_package_manager() {
        let packages = vec!["xvfb".to_string(), "openbox".to_string()];
        let command = render_install_command(DesktopPackageManager::Apk, false, &packages);
        assert_eq!(command, "apk add --no-cache xvfb openbox");
    }
}
