use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::MAX_REPLY_BYTES;

const INSPECTOR_TIMEOUT: Duration = Duration::from_secs(25);

#[derive(Debug)]
pub enum InspectionOutcome {
    Supported(Value),
    Unsupported,
}

pub trait ResourceInspector: Send {
    fn inspect(&self, source: &Path) -> InspectionOutcome;
}

pub struct ProcessResourceInspector {
    program: PathBuf,
    arguments: Vec<String>,
}

impl ProcessResourceInspector {
    pub fn new(program: PathBuf, arguments: Vec<String>) -> Self {
        Self { program, arguments }
    }
}

impl ResourceInspector for ProcessResourceInspector {
    fn inspect(&self, source: &Path) -> InspectionOutcome {
        let mut command = Command::new(&self.program);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW for the console sidecar.
        }
        let mut child = match command.args(&self.arguments)
            .arg("--input")
            .arg(source)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .stdout(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(_) => return InspectionOutcome::Unsupported,
        };
        let Some(mut stdout) = child.stdout.take() else {
            let _ = child.kill();
            return InspectionOutcome::Unsupported;
        };
        let reader = thread::spawn(move || {
            let mut collected = Vec::new();
            let mut buffer = [0_u8; 64 * 1024];
            let mut oversized = false;
            loop {
                let count = stdout.read(&mut buffer).map_err(|_| ())?;
                if count == 0 {
                    break;
                }
                if collected.len().saturating_add(count) > MAX_REPLY_BYTES {
                    oversized = true;
                } else if !oversized {
                    collected.extend_from_slice(&buffer[..count]);
                }
            }
            if oversized {
                Err(())
            } else {
                Ok(collected)
            }
        });
        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if started.elapsed() < INSPECTOR_TIMEOUT => {
                    thread::sleep(Duration::from_millis(10));
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
            }
        };
        let bytes = reader.join().ok().and_then(Result::ok);
        if status.is_none_or(|value| !value.success()) || bytes.is_none() {
            return InspectionOutcome::Unsupported;
        }
        let value: Value = match serde_json::from_slice(&bytes.unwrap()) {
            Ok(value) => value,
            Err(_) => return InspectionOutcome::Unsupported,
        };
        if value.get("supported").and_then(Value::as_bool) == Some(true) {
            InspectionOutcome::Supported(value)
        } else {
            InspectionOutcome::Unsupported
        }
    }
}

pub struct UnavailableResourceInspector;

impl ResourceInspector for UnavailableResourceInspector {
    fn inspect(&self, _source: &Path) -> InspectionOutcome {
        InspectionOutcome::Unsupported
    }
}

pub struct TestResourceInspector;

impl ResourceInspector for TestResourceInspector {
    fn inspect(&self, _source: &Path) -> InspectionOutcome {
        InspectionOutcome::Supported(serde_json::json!({
            "supported": true,
            "schemaVersion": "edit-content-resource-inspection/v1",
            "pages": [],
        }))
    }
}
