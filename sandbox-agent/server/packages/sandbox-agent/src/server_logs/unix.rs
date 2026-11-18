use std::os::unix::io::AsRawFd;
use std::path::PathBuf;

use chrono::{Datelike, Duration, TimeDelta, TimeZone, Utc};

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

        let log_file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .append(true)
            .open(&path)?;
        let log_fd = log_file.as_raw_fd();

        unsafe {
            libc::dup2(log_fd, libc::STDOUT_FILENO);
            libc::dup2(log_fd, libc::STDERR_FILENO);
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
