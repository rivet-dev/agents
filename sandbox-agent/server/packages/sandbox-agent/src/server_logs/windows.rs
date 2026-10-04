use std::path::PathBuf;

use chrono::{Datelike, Duration, TimeDelta, TimeZone, Utc};
use windows::{
    core::PCSTR,
    Win32::{
        Foundation::{HANDLE, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{
            CreateFileA, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_WRITE, FILE_SHARE_READ, OPEN_ALWAYS,
        },
        System::Console::{SetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE},
    },
};

pub struct ServerLogs {
    path: PathBuf,
    retention: Duration,

    last_rotation: chrono::DateTime<Utc>,
    next_rotation: chrono::DateTime<Utc>,
}

impl ServerLogs {
    pub fn new(path: PathBuf, retention: std::time::Duration) -> Self {
        Self {
            path,
            retention: chrono::Duration::from_std(retention).expect("invalid retention duration"),
            last_rotation: Utc.timestamp_opt(0, 0).unwrap(),
            next_rotation: Utc.timestamp_opt(0, 0).unwrap(),
        }
    }

    pub fn start_sync(mut self) -> Result<std::thread::JoinHandle<()>, std::io::Error> {
        std::fs::create_dir_all(&self.path)?;
        self.rotate_sync()?;

        Ok(std::thread::spawn(|| self.run_sync()))
    }

    fn run_sync(mut self) {
        loop {
            let now = Utc::now();

            if self.next_rotation - now > Duration::seconds(5) {
                std::thread::sleep(
                    (self.next_rotation - now - Duration::seconds(5))
                        .max(TimeDelta::default())
                        .to_std()
                        .expect("bad duration"),
                );
            } else if now.ordinal() != self.last_rotation.ordinal() {
                if let Err(err) = self.rotate_sync() {
                    tracing::error!(?err, "failed logs rotation");
                }
            } else {
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
        }
    }

    fn rotate_sync(&mut self) -> Result<(), std::io::Error> {
        self.last_rotation = Utc::now();
        self.next_rotation = Utc.from_utc_datetime(
            &(self
                .last_rotation
                .date_naive()
                .and_hms_opt(0, 0, 0)
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "invalid date"))?
                + Duration::days(1)),
        );

        let file_name = format!("log-{}", self.last_rotation.format("%m-%d-%y"));
        let path = self.path.join(file_name);

        let path_str = path
            .to_str()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "invalid path"))?;
        let path_cstr = std::ffi::CString::new(path_str)
            .map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err.to_string()))?;

        unsafe {
            let file_handle = CreateFileA(
                PCSTR(path_cstr.as_ptr() as *const u8),
                FILE_GENERIC_WRITE.0,
                FILE_SHARE_READ,
                None,
                OPEN_ALWAYS,
                FILE_ATTRIBUTE_NORMAL,
                HANDLE::default(),
            )
            .map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err.to_string()))?;

            if file_handle == INVALID_HANDLE_VALUE {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "failed to create log file",
                ));
            }

            SetStdHandle(STD_OUTPUT_HANDLE, file_handle)
                .map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err.to_string()))?;
            SetStdHandle(STD_ERROR_HANDLE, file_handle)
                .map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err.to_string()))?;
        }

        self.prune_sync()
    }

    fn prune_sync(&self) -> Result<(), std::io::Error> {
        let mut entries = std::fs::read_dir(&self.path)?;
        let mut pruned = 0;

        while let Some(entry) = entries.next() {
            let entry = entry?;
            let metadata = entry.metadata()?;
            let modified = chrono::DateTime::<Utc>::from(metadata.modified()?);
            if modified < Utc::now() - self.retention {
                pruned += 1;
                let _ = std::fs::remove_file(entry.path());
            }
        }

        if pruned != 0 {
            tracing::debug!("pruned {pruned} log files");
        }

        Ok(())
    }
}
