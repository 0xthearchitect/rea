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
// One owner retains the process, pipes and stderr drainer between native tasks.
pub struct Bridge {
    child: OwnedChild,
    reader: BufReader<std::process::ChildStdout>,
    stdin: Option<ChildStdin>,
    drain: Option<std::thread::JoinHandle<()>>,
    node: String,
    rea: String,
    project: String,
}
impl Bridge {
    fn spawn(settings: &Settings, bridge: &Path, project: &str) -> Result<Self> {
        for path in [&settings.node, &settings.rea] {
            if !Path::new(path).is_absolute() || !Path::new(path).is_file() {
                return Err(Error::new(
                    "missing_dependency",
                    format!("Configured dependency does not exist: {path}"),
                ));
            }
        }
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
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| Error::new("process", "Bridge input unavailable"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| Error::new("process", "Bridge stderr unavailable"))?;
        let drain = std::thread::spawn(move || {
            let _ = std::io::copy(&mut BufReader::new(stderr), &mut std::io::sink());
        });
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::new("process", "Bridge output unavailable"))?;
        Ok(Self {
            child,
            reader: BufReader::new(stdout),
            stdin: Some(stdin),
            drain: Some(drain),
            node: settings.node.clone(),
            rea: settings.rea.clone(),
            project: project.into(),
        })
    }
    fn request_events(
        &mut self,
        mut request: Value,
        input: InputHandle,
        mut event: impl FnMut(Value) -> Result<()>,
    ) -> Result<Value> {
        request["node"] = json!(self.node);
        request["rea"] = json!(self.rea);
        let mut stdin = self
            .stdin
            .take()
            .ok_or_else(|| Error::new("process", "Bridge input has no owner"))?;
        let send =
            writeln!(stdin, "{}", serde_json::to_string(&request)?).and_then(|_| stdin.flush());
        self.stdin = Some(stdin);
        send?;
        *input
            .lock()
            .map_err(|_| Error::new("process", "Bridge input lock poisoned"))? = self.stdin.take();
        let result = (|| loop {
            let mut line = Vec::new();
            let n = std::io::Read::by_ref(&mut self.reader)
                .take(8 * 1024 * 1024 + 1)
                .read_until(b'\n', &mut line)?;
            if n == 0 {
                return Err(Error::new(
                    "process",
                    "REA bridge exited without a result; cleanup is unknown",
                ));
            }
            if n > 8 * 1024 * 1024 {
                return Err(Error::new(
                    "resource_constraint",
                    "Bridge message exceeds 8 MiB",
                ));
            }
            let event_json: Value = serde_json::from_slice(&line)?;
            match event_json["type"].as_str() {
                Some("progress") => event(
                    json!({"type":"activity","message": event_json["value"].as_str().unwrap_or("REA progress observation").chars().take(8192).collect::<String>()}),
                )?,
                Some("agent_event") => event(event_json["value"].clone())?,
                Some("result") => return Ok(event_json["value"].clone()),
                Some("error") => {
                    return Err(Error::new(
                        if event_json["value"]["cancellation_requested"].as_bool() == Some(true) {
                            "cancelled_unverified"
                        } else {
                            "rea_error"
                        },
                        event_json["value"]["message"]
                            .as_str()
                            .unwrap_or("REA bridge failed"),
                    ))
                }
                _ => return Err(Error::new("malformed_response", "Unknown bridge event")),
            }
        })();
        self.stdin = input
            .lock()
            .map_err(|_| Error::new("process", "Bridge input lock poisoned"))?
            .take();
        result
    }
    fn request(
        &mut self,
        request: Value,
        input: InputHandle,
        mut progress: impl FnMut(String),
    ) -> Result<Value> {
        self.request_events(request, input, |event| {
            if event["type"] != "activity" {
                return Err(Error::new(
                    "malformed_response",
                    "Unexpected agent event in analysis request",
                ));
            }
            progress(
                event["message"]
                    .as_str()
                    .unwrap_or("REA progress observation")
                    .into(),
            );
            Ok(())
        })
    }
    fn wait(&mut self) -> Result<()> {
        self.stdin.take();
        let _ = std::io::copy(&mut self.reader, &mut std::io::sink());
        let status = self.child.wait()?;
        if let Some(drain) = self.drain.take() {
            let _ = drain.join();
        }
        if !status.success() {
            return Err(Error::new(
                "process",
                format!("REA bridge exited {status}; cleanup is unknown"),
            ));
        }
        Ok(())
    }
    pub fn close(&mut self) -> Result<()> {
        if let Some(status) = self.child.try_wait()? {
            if status.success() {
                return Ok(());
            }
            return Err(Error::new(
                "process",
                format!("REA bridge exited {status}; cleanup is unknown"),
            ));
        }
        self.request(
            json!({"action":"shutdown"}),
            Arc::new(Mutex::new(None)),
            |_| {},
        )?;
        self.wait()
    }
}
impl Drop for Bridge {
    fn drop(&mut self) {
        // Normal shutdown is explicit. Unexpected host teardown closes stdin so
        // the JS owner can close its MCP transport; OwnedChild is the last guard.
        self.stdin.take();
    }
}
#[derive(Default)]
pub struct NativeBridge(pub Option<Bridge>);
impl NativeBridge {
    pub fn close(&mut self) -> Result<()> {
        if let Some(bridge) = self.0.as_mut() {
            bridge.close()?;
        }
        self.0 = None;
        Ok(())
    }
    pub fn run(
        &mut self,
        settings: &Settings,
        bridge: &Path,
        project: &str,
        mut request: Value,
        input: InputHandle,
        progress: impl FnMut(String),
    ) -> Result<Value> {
        let matches = self.0.as_ref().is_some_and(|b| {
            b.node == settings.node && b.rea == settings.rea && b.project == project
        });
        if !matches {
            self.close()?;
        }
        if self.0.is_none() {
            self.0 = Some(Bridge::spawn(settings, bridge, project)?);
        }
        request["keep_alive"] = json!(true);
        let result = self.0.as_mut().unwrap().request(request, input, progress);
        if result.is_err() {
            // The bridge reports task failures only after closing its session.
            // Wait for that owner; a cleanup failure leaves ownership here.
            let cleanup = self.0.as_mut().unwrap().wait();
            if let Err(e) = cleanup {
                return Err(Error::new(
                    "cleanup_unknown",
                    format!("{}; {}", result.err().unwrap().message, e.message),
                ));
            }
            self.0 = None;
        }
        result
    }
}
pub fn run(
    settings: &Settings,
    bridge: &Path,
    request: Value,
    input: InputHandle,
    progress: impl FnMut(String),
) -> Result<Value> {
    let mut process = Bridge::spawn(settings, bridge, "")?;
    let result = process.request(request, input, progress);
    let cleanup = process.wait();
    match (result, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Err(error), Err(cleanup)) => Err(Error::new(
            "cleanup_unknown",
            format!("{}; {}", error.message, cleanup.message),
        )),
    }
}

pub fn run_agent(
    settings: &Settings,
    bridge: &Path,
    request: Value,
    input: InputHandle,
    event: impl FnMut(Value) -> Result<()>,
) -> Result<Value> {
    let mut process = Bridge::spawn(settings, bridge, "")?;
    let result = process.request_events(request, input, event);
    let cleanup = process.wait();
    match (result, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Err(error), Err(cleanup)) => Err(Error::new(
            "cleanup_unknown",
            format!("{}; {}", error.message, cleanup.message),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Requires STUDIO_SESSION_TARGET, STUDIO_SESSION_NODE and STUDIO_SESSION_REA with a real configured provider"]
    fn real_native_session_reuses_recovers_and_invalidates() {
        let workspace = tempfile::tempdir().unwrap();
        let target = workspace.path().join("target");
        std::fs::copy(std::env::var("STUDIO_SESSION_TARGET").unwrap(), &target).unwrap();
        let settings = Settings {
            node: std::env::var("STUDIO_SESSION_NODE").unwrap(),
            rea: std::env::var("STUDIO_SESSION_REA").unwrap(),
        };
        let bridge = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/bridge.mjs");
        let mut owner = NativeBridge::default();
        let mut sequence = 0;
        let mut task = |owner: &mut NativeBridge, operation: &str, query: &str| {
            sequence += 1;
            let directory = workspace.path().join(sequence.to_string());
            std::fs::create_dir(&directory).unwrap();
            owner.run(&settings,&bridge,"owned-project",json!({"action":"analyze_native","target":target,"output":directory.join("evidence.json"),"projection":directory.join("projection.json"),"native_request":{"operation":operation,"query":query}}),Arc::new(Mutex::new(None)), |_|{})
        };
        assert_eq!(
            task(&mut owner, "function", "main").unwrap()["session_reused"],
            false
        );
        assert_eq!(
            task(&mut owner, "instructions", "main").unwrap()["session_reused"],
            true
        );
        assert!(task(&mut owner, "function", "studio_missing_procedure_98b9f2").is_err());
        assert!(
            owner.0.is_none(),
            "Failed session must be retired after confirmed process exit"
        );
        let recovered = task(&mut owner, "function", "main").unwrap();
        assert_eq!(recovered["session_reused"], false);
        let old: Value = serde_json::from_slice(
            &std::fs::read(recovered["projection"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
        std::fs::OpenOptions::new()
            .append(true)
            .open(&target)
            .unwrap()
            .write_all(b"studio-owned-test")
            .unwrap();
        let changed = task(&mut owner, "instructions", "main").unwrap();
        assert_eq!(
            changed["session_reused"], false,
            "Changed bytes must reopen the provider"
        );
        let new: Value = serde_json::from_slice(
            &std::fs::read(changed["projection"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
        assert_ne!(old["target_sha256"], new["target_sha256"]);
        owner.close().unwrap();
        assert!(owner.0.is_none());
    }
}
