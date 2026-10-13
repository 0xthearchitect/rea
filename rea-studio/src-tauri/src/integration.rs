use crate::models::*;
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
};
pub type InputHandle = Arc<Mutex<Option<ChildStdin>>>;
struct OwnedChild(Child);
impl std::ops::Deref for OwnedChild {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.0
    }
}
impl std::ops::DerefMut for OwnedChild {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.0
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}
pub fn run(
    settings: &Settings,
    bridge: &Path,
    mut request: Value,
    input: InputHandle,
    mut progress: impl FnMut(String),
) -> Result<Value> {
    if settings.node.is_empty() || settings.rea.is_empty() {
        return Err(Error::new(
            "missing_dependency",
            "Choose Node and REA paths in Connection settings",
        ));
    }
    for path in [&settings.node, &settings.rea] {
        if !Path::new(path).is_absolute() || !Path::new(path).is_file() {
            return Err(Error::new(
                "missing_dependency",
                format!("Configured dependency does not exist: {path}"),
            ));
        }
    }
    request["node"] = json!(settings.node);
    request["rea"] = json!(settings.rea);
    let mut cmd = Command::new(&settings.node);
    cmd.arg(bridge)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let mut child = OwnedChild(cmd.spawn()?);
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| Error::new("process", "Bridge input unavailable"))?;
    writeln!(stdin, "{}", serde_json::to_string(&request)?)?;
    stdin.flush()?;
    *input
        .lock()
        .map_err(|_| Error::new("process", "Bridge input lock poisoned"))? = Some(stdin);
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| Error::new("process", "Bridge stderr unavailable"))?;
    let drain = std::thread::spawn(move || {
        let mut r = BufReader::new(stderr);
        let mut sink = std::io::sink();
        let _ = std::io::copy(&mut r, &mut sink);
    });
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| Error::new("process", "Bridge output unavailable"))?;
    let mut reader = BufReader::new(stdout);
    let mut final_value = None;
    let mut failure = None;
    loop {
        let mut line = Vec::new();
        let read = std::io::Read::by_ref(&mut reader)
            .take(8 * 1024 * 1024 + 1)
            .read_until(b'\n', &mut line);
        let n = match read {
            Ok(n) => n,
            Err(e) => {
                failure = Some(e.into());
                break;
            }
        };
        if n == 0 {
            break;
        }
        if n > 8 * 1024 * 1024 {
            failure = Some(Error::new(
                "resource_constraint",
                "Bridge message exceeds 8 MiB",
            ));
            break;
        }
        match serde_json::from_slice::<Value>(&line) {
            Ok(event) => match event["type"].as_str() {
                Some("progress") => progress(
                    event["value"]
                        .as_str()
                        .unwrap_or("REA progress observation")
                        .chars()
                        .take(8192)
                        .collect(),
                ),
                Some("result") => final_value = Some(event["value"].clone()),
                Some("error") => {
                    failure = Some(Error::new(
                        if event["value"]["cancellation_requested"].as_bool() == Some(true) {
                            "cancelled_unverified"
                        } else {
                            "rea_error"
                        },
                        event["value"]["message"]
                            .as_str()
                            .unwrap_or("REA bridge failed"),
                    ))
                }
                _ => {
                    failure = Some(Error::new("malformed_response", "Unknown bridge event"));
                }
            },
            Err(e) => {
                failure = Some(e.into());
                break;
            }
        }
    }
    if failure.is_some() {
        if let Ok(mut handle) = input.lock() {
            if let Some(stdin) = handle.as_mut() {
                let _ = writeln!(stdin, "{{\"action\":\"cancel\"}}");
                let _ = stdin.flush();
            }
        }
    }
    *input
        .lock()
        .map_err(|_| Error::new("process", "Bridge input lock poisoned"))? = None;
    // Drain without retaining more output while the bridge closes its owned MCP transport.
    let _ = std::io::copy(&mut reader, &mut std::io::sink());
    let status = child.wait()?;
    let _ = drain.join();
    if let Some(error) = failure {
        return Err(error);
    }
    if !status.success() {
        return Err(Error::new(
            "process",
            format!("REA bridge exited {status}; cleanup is unknown"),
        ));
    }
    final_value
        .ok_or_else(|| Error::new("malformed_response", "REA bridge exited without a result"))
}
