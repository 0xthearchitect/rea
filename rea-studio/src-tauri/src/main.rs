#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod integration;
mod agents;
mod models;
mod presentation;
mod security;
mod storage;
use models::*;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use storage::Store;
use tauri::{Emitter, Manager, State};
struct App {
    _workspace_lock: std::fs::File,
    store: Store,
    bridge: PathBuf,
    running: Mutex<HashMap<String, integration::InputHandle>>,
    native_bridge: Mutex<integration::NativeBridge>,
}
fn task_error(e: impl std::fmt::Display) -> Error {
    Error::new("internal", e.to_string())
}
#[tauri::command]
fn get_settings(app: State<'_, App>) -> Result<Settings> {
    let mut settings = app.store.settings()?;
    if !cfg!(feature = "custom-protocol") {
        let repo = dunce::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))?;
        if settings.rea.is_empty() {
            let installed =
                repo.join(".cache/studio-rea-runtime/node_modules/rea-agents/scripts/rea.mjs");
            let entry = if installed.is_file() {
                installed
            } else {
                repo.join("scripts/rea.mjs")
            };
            if entry.is_file() {
                settings.rea = entry.to_string_lossy().into_owned();
            }
        }
        if settings.node.is_empty() {
            let node = repo.join(".cache/studio-toolchain/node-v24.18.0-win-x64/node.exe");
            if node.is_file() {
                settings.node = node.to_string_lossy().into_owned();
            }
        }
    }
    if settings.node.is_empty() {
        if let Some(path) = std::env::var_os("PATH") {
            for p in std::env::split_paths(&path) {
                let node = p.join(if cfg!(windows) { "node.exe" } else { "node" });
                if node.is_file() {
                    settings.node = dunce::canonicalize(node)?.to_string_lossy().into_owned();
                    break;
                }
            }
        }
    }
    Ok(settings)
}
#[tauri::command]
async fn pick_connection_file(app: tauri::AppHandle, field: String) -> Result<Option<Settings>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<App>();
        let mut settings = get_settings(state.clone())?;
        let title = match field.as_str() {
            "node" => "Select your trusted Node executable",
            "rea" => "Select REA's installed scripts/rea.mjs",
            _ => return Err(Error::new("invalid_request", "Unknown dependency field")),
        };
        let path = rfd::FileDialog::new().set_title(title).pick_file();
        if let Some(path) = path {
            let running=state.running.lock().map_err(task_error)?;
            if !running.is_empty() {return Err(Error::new("job_active","Finish or cancel analysis before changing connection settings"));}
            state.native_bridge.lock().map_err(task_error)?.close()?;
            path.canonicalize()?;
            let path = path.to_str().ok_or_else(||Error::new("invalid_encoding","The selected dependency path cannot be represented without changing its value"))?.to_owned();
            if field == "node" {
                settings.node = path;
            } else {
                settings.rea = path;
            }
            state.store.save_settings(&settings)?;
            Ok(Some(settings))
        } else {
            Ok(None)
        }
    })
    .await
    .map_err(task_error)?
}
#[tauri::command]
async fn detect_connection(app: tauri::AppHandle) -> Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<App>();
        let settings = get_settings(state.clone())?;
        integration::run(
            &settings,
            &state.bridge,
            json!({"action":"detect"}),
            Arc::new(Mutex::new(None)),
            |_| {},
        )
    })
    .await
    .map_err(task_error)?
}
#[tauri::command]
fn list_projects(app: State<'_, App>) -> Result<Vec<Project>> {
    app.store.projects()
}
#[tauri::command]
async fn import_target(
    app: tauri::AppHandle,
    name: String,
    format: String,
) -> Result<Option<Project>> {
    tauri::async_runtime::spawn_blocking(move || {
        let workflow = match format.as_str() {
            "directory" | "asar" => "javascript",
            "native" => "native",
            _ => return Err(Error::new("unsupported_target", "Choose directory, ASAR, or native binary")),
        };
        let dialog = rfd::FileDialog::new().set_title("Import a target for static analysis");
        #[cfg(feature = "e2e")]
        let path = std::env::var_os("STUDIO_E2E_TARGET").map(PathBuf::from);
        #[cfg(not(feature = "e2e"))]
        let path: Option<PathBuf> = None;
        let path = if path.is_some() {
            path
        } else {
            match format.as_str() {
                "directory" => dialog.pick_folder(),
                "asar" => dialog.add_filter("Electron ASAR", &["asar"]).pick_file(),
                "native" => dialog.pick_file(),
                _ => return Err(Error::new("unsupported_target", "Choose directory or ASAR")),
            }
        };
        path.map(|p| app.state::<App>().store.create_project(&name, &p, workflow))
            .transpose()
    })
    .await
    .map_err(task_error)?
}
#[tauri::command]
fn rename_project(app: State<'_, App>, project_id: String, name: String) -> Result<()> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(Error::new(
            "invalid_request",
            "Project name requires 1–120 characters",
        ));
    }
    app.store.db()?.execute(
        "UPDATE projects SET name=?2 WHERE id=?1",
        rusqlite::params![project_id, name],
    )?;
    Ok(())
}
#[tauri::command]
async fn delete_project(app: tauri::AppHandle, project_id: String) -> Result<bool> {
    tauri::async_runtime::spawn_blocking(move || {
        let state=app.state::<App>();
        if !state.running.lock().map_err(task_error)?.is_empty() {return Err(Error::new("job_active","Wait for analysis jobs to finish before deleting a project"));}
        let confirmed=rfd::MessageDialog::new().set_title("Delete investigation?").set_description("This removes Studio metadata and saved Evidence for this project. Your original target is preserved.").set_buttons(rfd::MessageButtons::YesNo).show();
        if confirmed!=rfd::MessageDialogResult::Yes {return Ok(false);}
        // A job may have started while the native dialog was open. Hold the
        // admission lock through closure, file cleanup and metadata deletion.
        let running=state.running.lock().map_err(task_error)?;
        if !running.is_empty() {return Err(Error::new("job_active","An analysis started while confirmation was open; finish it before deleting"));}
        state.native_bridge.lock().map_err(task_error)?.close()?;
        let jobs=state.store.jobs(&project_id)?;
        let root=state.store.root.join("jobs").canonicalize()?;
        for job in jobs { let path=state.store.job_dir(&job.id)?; if path.exists() { let resolved=path.canonicalize()?; if !resolved.starts_with(&root) || resolved==root {return Err(Error::new("invalid_path","Evidence storage ownership could not be established"));} std::fs::remove_dir_all(&resolved)?; } }
        for turn in state.store.agent_turn_ids(&project_id)? {
            let path=state.store.agent_dir(&turn)?;
            if path.exists() {
                let owned_root=state.store.root.join("agents").canonicalize()?;
                let resolved=path.canonicalize()?;
                if !resolved.starts_with(&owned_root) || resolved==owned_root {return Err(Error::new("invalid_path","Agent storage ownership could not be established"));}
                std::fs::remove_dir_all(resolved)?;
            }
        }
        state.store.db()?.execute("DELETE FROM projects WHERE id=?1",[project_id])?; Ok(true)
    }).await.map_err(task_error)?
}
#[tauri::command]
fn list_jobs(app: State<'_, App>, project_id: String) -> Result<Vec<Job>> {
    app.store.jobs(&project_id)
}
#[tauri::command]
fn job_logs(app: State<'_, App>, job_id: String) -> Result<Vec<Activity>> {
    app.store.logs(&job_id)
}
#[tauri::command]
fn start_analysis(
    app: tauri::AppHandle,
    project_id: String,
    source_paths: Vec<String>,
    native_request: Option<NativeRequest>,
) -> Result<String> {
    if source_paths.len() > 256
        || source_paths
            .iter()
            .any(|s| s.len() > 4096 || s.contains('\0'))
    {
        return Err(Error::new(
            "invalid_request",
            "At most 256 exact source paths, each ≤4096 bytes",
        ));
    }
    let state = app.state::<App>();
    let workflow = state.store.workflow(&project_id)?;
    match workflow.as_str() {
        "javascript" if native_request.is_none() => {},
        "native" if source_paths.is_empty() && native_request.is_some() => {},
        _ => return Err(Error::new("invalid_request", "Analysis inputs do not match the selected project workflow")),
    }
    if let Some(request) = &native_request {
        if request.query.len() > 4096 || request.query.contains('\0') {
            return Err(Error::new("invalid_request", "Native query must be at most 4096 bytes without NUL"));
        }
    }
    let mut running = state.running.lock().map_err(task_error)?;
    if !running.is_empty() {
        return Err(Error::new(
            "capacity",
            "One active analysis is supported. Wait for it to finish.",
        ));
    }
    let settings = get_settings(state.clone())?;
    if settings.node.is_empty() || settings.rea.is_empty() {
        return Err(Error::new(
            "missing_dependency",
            "Configure the REA connection first",
        ));
    }
    let (id, target) = state.store.begin_job(&project_id)?;
    let input = Arc::new(Mutex::new(None));
    running.insert(id.clone(), input.clone());
    let store = state.store.clone();
    let bridge = state.bridge.clone();
    let job = id.clone();
    drop(running);
    drop(state);
    std::thread::spawn(move || {
        let result = (|| -> Result<()> {
            let dir = store.job_dir(&job)?;
            let request = json!({
                "action": if workflow == "native" {"analyze_native"} else {"analyze"},
                "target": target,
                "output": dir.join("evidence.json"),
                "projection": dir.join("projection.json"),
                "source_paths": source_paths,
                "native_request": native_request,
            });
            let progress = |message: String| {
                let _ = store.log(&job, &message);
                let _ = app.emit("studio:activity", Activity {
                    job_id: job.clone(), message, at: now(),
                });
            };
            let state = app.state::<App>();
            let result = if workflow == "native" {
                state.native_bridge.lock().map_err(task_error)?.run(
                    &settings, &bridge, &project_id, request, input, progress,
                )?
            } else {
                state.native_bridge.lock().map_err(task_error)?.close()?;
                integration::run(&settings, &bridge, request, input, progress)?
            };
            if result["session_reused"].as_bool() == Some(true) {
                store.log(&job, "Native task completed using the retained REA session.")?;
            }
            let projection = dir.join("projection.json");
            store.index(
                &job,
                result["version"]
                    .as_str()
                    .ok_or_else(|| Error::new("malformed_response", "Missing REA version"))?,
                &projection,
            )?;
            // The original Evidence remains authoritative; the temporary projection is superseded by SQLite.
            if let Err(e) = std::fs::remove_file(projection) {
                store.log(
                    &job,
                    &format!("Index ready; temporary projection cleanup failed: {e}"),
                )?;
            }
            Ok(())
        })();
        if let Err(e) = result {
            let _ = store.finish_error(&job, &e.message, e.code == "cancelled_unverified");
        }
        if let Ok(mut running) = app.state::<App>().running.lock() {
            running.remove(&job);
        }
        let _ = app.emit("studio:job-finished", json!({"job_id":job}));
    });
    Ok(id)
}
#[tauri::command]
fn cancel_analysis(app: State<'_, App>, job_id: String) -> Result<()> {
    let running = app.running.lock().map_err(task_error)?;
    let input = running
        .get(&job_id)
        .ok_or_else(|| Error::new("job_inactive", "This job is no longer running"))?;
    let mut guard = input.lock().map_err(task_error)?;
    let stdin = guard.as_mut().ok_or_else(|| {
        Error::new(
            "not_ready",
            "Connection is still starting; try cancellation again shortly",
        )
    })?;
    writeln!(stdin, "{{\"action\":\"cancel\"}}")?;
    stdin.flush()?;
    app.store.db()?.execute("UPDATE jobs SET state='cancellation_requested',message='Cancellation requested; upstream cleanup is not yet verified' WHERE id=?1 AND state='running'",[job_id])?;
    Ok(())
}
#[tauri::command]
async fn search_entities(
    app: tauri::AppHandle,
    job_id: String,
    search: String,
    kind: String,
    offset: i64,
    limit: i64,
) -> Result<Page> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<App>()
            .store
            .page(&job_id, &search, &kind, offset, limit)
    })
    .await
    .map_err(task_error)?
}
#[tauri::command]
async fn graph_view(app: tauri::AppHandle, job_id: String, focus: String) -> Result<Graph> {
    tauri::async_runtime::spawn_blocking(move || app.state::<App>().store.graph(&job_id, &focus))
        .await
        .map_err(task_error)?
}
#[tauri::command]
fn entity_kinds(app: State<'_, App>, job_id: String) -> Result<Vec<String>> {
    app.store.kinds(&job_id)
}
#[tauri::command]
fn inspect_evidence(app: State<'_, App>, job_id: String, entity_id: String) -> Result<Evidence> {
    app.store.evidence(&job_id, &entity_id)
}
#[tauri::command]
async fn inspect_source(
    app: tauri::AppHandle,
    job_id: String,
    entity_id: String,
) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<App>().store.source(&job_id, &entity_id))
    .await
    .map_err(task_error)?
}
#[tauri::command]
async fn export_data(
    app: tauri::AppHandle,
    job_id: String,
    format: String,
    focus: String,
) -> Result<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        if !matches!(format.as_str(), "graph" | "evidence") {
            return Err(Error::new("invalid_request", "Unsupported export format"));
        }
        let state = app.state::<App>();
        // Validate and retain the source before creating a destination.
        let mut source=if format=="evidence" {Some(std::fs::File::open(state.store.job_dir(&job_id)?.join("evidence.json"))?)} else {None};
        let graph=if format=="graph" {Some(state.store.graph(&job_id,&focus)?)} else {None};
        let path = rfd::FileDialog::new()
            .set_title("Export to a new JSON file")
            .set_file_name(if format == "evidence" {
                "rea-evidence.json"
            } else {
                "rea-graph-view.json"
            })
            .add_filter("JSON", &["json"])
            .save_file();
        let Some(path) = path else {
            return Ok(None);
        };
        let selected_path=path.to_str().ok_or_else(||Error::new("invalid_encoding","The selected export path cannot be represented without changing its value"))?.to_owned();
        let mut output = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)?;
        match format.as_str() {
            "evidence" => {
                std::io::copy(source.as_mut().unwrap(), &mut output)?;
            }
            "graph" => {
                serde_json::to_writer(&mut output, graph.as_ref().unwrap())?;
            }
            _ => return Err(Error::new("invalid_request", "Unsupported export format")),
        }
        output.sync_all()?;
        Ok(Some(selected_path))
    })
    .await
    .map_err(task_error)?
}

#[tauri::command]
fn has_active_task(app: State<'_, App>) -> Result<bool> {
    Ok(!app.running.lock().map_err(task_error)?.is_empty())
}
#[tauri::command]
fn get_agent_settings(app: State<'_, App>) -> Result<agents::AgentSettings> {
    let mut settings = app.store.agent_settings()?;
    if settings.executable.is_empty() {
        if let Some(paths) = std::env::var_os("PATH") {
            for directory in std::env::split_paths(&paths) {
                let executable = directory.join(if cfg!(windows) { "codex.exe" } else { "codex" });
                if executable.is_file() {
                    settings.executable = executable
                        .to_str()
                        .ok_or_else(|| {
                            Error::new("invalid_encoding", "Agent path cannot be represented")
                        })?
                        .into();
                    break;
                }
            }
        }
    }
    Ok(settings)
}
#[tauri::command]
fn save_agent_settings(app: State<'_, App>, settings: agents::AgentSettings) -> Result<()> {
    let running = app.running.lock().map_err(task_error)?;
    if !running.is_empty() {
        return Err(Error::new(
            "job_active",
            "Wait for the active task before changing agent settings",
        ));
    }
    app.store.save_agent_settings(&settings)
}
#[tauri::command]
async fn pick_agent_file(app: tauri::AppHandle) -> Result<Option<agents::AgentSettings>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<App>();
        let path = rfd::FileDialog::new()
            .set_title("Select your trusted Codex executable")
            .pick_file();
        let Some(path) = path else { return Ok(None) };
        let mut settings = get_agent_settings(state.clone())?;
        settings.executable = path
            .to_str()
            .ok_or_else(|| Error::new("invalid_encoding", "Agent path cannot be represented"))?
            .into();
        save_agent_settings(state, settings)?;
        Ok(Some(app.state::<App>().store.agent_settings()?))
    })
    .await
    .map_err(task_error)?
}
#[tauri::command]
async fn detect_agent(app: tauri::AppHandle) -> Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<App>();
        let agent = get_agent_settings(state.clone())?;
        let settings = get_settings(state.clone())?;
        if agent.executable.is_empty() {
            return Err(Error::new(
                "missing_dependency",
                "Select an installed Codex executable",
            ));
        }
        integration::run(
            &settings,
            &state.bridge,
            json!({"action":"detect_agent","agent":agent.executable}),
            Arc::new(Mutex::new(None)),
            |_| {},
        )
    })
    .await
    .map_err(task_error)?
}
#[tauri::command]
fn agent_conversations(
    app: State<'_, App>,
    project_id: String,
) -> Result<Vec<agents::Conversation>> {
    app.store.conversations(&project_id)
}
#[tauri::command]
fn new_agent_conversation(app: State<'_, App>, project_id: String) -> Result<String> {
    app.store.new_conversation(&project_id)
}
#[tauri::command]
fn agent_turns(app: State<'_, App>, conversation_id: String, offset: i64) -> Result<Value> {
    app.store.agent_turns(&conversation_id, offset)
}
#[tauri::command]
fn agent_context(
    app: State<'_, App>,
    project_id: String,
    job_id: String,
    entity_id: String,
) -> Result<Value> {
    app.store.agent_context(&project_id, &job_id, &entity_id)
}
#[tauri::command]
fn start_agent_turn(
    app: tauri::AppHandle,
    conversation_id: String,
    question: String,
    job_id: String,
    entity_id: String,
    provider_id: Option<String>,
) -> Result<String> {
    let state = app.state::<App>();
    let mut running = state.running.lock().map_err(task_error)?;
    if !running.is_empty() {
        return Err(Error::new(
            "capacity",
            "One active REA or agent task is supported",
        ));
    }
    let project: String = state.store.db()?.query_row(
        "SELECT project_id FROM agent_conversations WHERE id=?1",
        [&conversation_id],
        |r| r.get(0),
    )?;
    let context = state.store.agent_context(&project, &job_id, &entity_id)?;
    let settings = get_settings(state.clone())?;
    let agent = get_agent_settings(state.clone())?;
    if agent.executable.is_empty() {
        return Err(Error::new(
            "missing_dependency",
            "Select an installed Codex executable",
        ));
    }
    let (turn, project, history) =
        state
            .store
            .begin_agent(&conversation_id, &question, &context)?;
    let workflow = state.store.workflow(&project)?;
    let target = state.store.target(&project)?;
    let directory = state.store.agent_dir(&turn)?;
    let input = Arc::new(Mutex::new(None));
    running.insert(turn.clone(), input.clone());
    let store = state.store.clone();
    let bridge = state.bridge.clone();
    let id = turn.clone();
    drop(running);
    drop(state);
    std::thread::spawn(move || {
        let result = (|| -> Result<()> {
            app.state::<App>()
                .native_bridge
                .lock()
                .map_err(task_error)?
                .close()?;
            let mut request = json!({"action":"agent","agent":agent.executable,"model":agent.model,"question":question,"target":target,"workflow":workflow,"directory":directory,"history":history,"context":context});
            if let Some(provider) = provider_id {
                request["provider_id"] = json!(provider);
            }
            let result = integration::run_agent(&settings, &bridge, request, input, |event| {
                store.agent_event(&id, &project, &event)?;
                let _ = app.emit(
                    "studio:agent-event",
                    json!({"turn_id":id,"conversation_id":conversation_id,"event":event}),
                );
                if event["type"] == "analysis" {
                    let _ = app.emit("studio:job-finished", json!({"job_id":event["id"]}));
                }
                Ok(())
            })?;
            store.finish_agent(&id, &result)?;
            Ok(())
        })();
        if let Err(e) = result {
            let _ = store.fail_agent(&id, &e);
        }
        if let Ok(mut running) = app.state::<App>().running.lock() {
            running.remove(&id);
        }
        let _ = app.emit(
            "studio:agent-finished",
            json!({"turn_id":id,"conversation_id":conversation_id}),
        );
    });
    Ok(turn)
}
#[tauri::command]
fn cancel_agent_turn(app: State<'_, App>, turn_id: String) -> Result<()> {
    let running = app.running.lock().map_err(task_error)?;
    let input = running
        .get(&turn_id)
        .ok_or_else(|| Error::new("job_inactive", "This agent turn is no longer active"))?;
    let mut input = input.lock().map_err(task_error)?;
    let stdin = input.as_mut().ok_or_else(|| {
        Error::new(
            "not_ready",
            "The connection is starting; try cancellation again shortly",
        )
    })?;
    writeln!(stdin, "{{\"action\":\"cancel\"}}")?;
    stdin.flush()?;
    app.store.db()?.execute("UPDATE agent_turns SET state='cancellation_requested',message='Cancellation requested; awaiting terminal status and cleanup' WHERE id=?1",[turn_id])?;
    Ok(())
}
fn main() {
    tauri::Builder::default().setup(|app| {
        #[cfg(feature="e2e")]
        let override_root = std::env::var_os("STUDIO_E2E_DATA").map(PathBuf::from);
        #[cfg(not(feature="e2e"))]
        let override_root: Option<PathBuf> = None;
        let root=override_root.unwrap_or(app.path().app_data_dir()?);
        std::fs::create_dir_all(&root)?;
        let workspace_lock=std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(root.join("studio.lock"))?;
        workspace_lock.try_lock().map_err(|e|std::io::Error::other(format!("Another Studio instance may own this workspace: {e}")))?;
        let store=Store::open(root).map_err(|e|std::io::Error::other(e.message))?;
        let bridge=if cfg!(feature="custom-protocol") {app.path().resource_dir()?.join("resources/bridge.mjs")} else {Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/bridge.mjs")};
        app.manage(App {_workspace_lock:workspace_lock,store,bridge,running:Mutex::new(HashMap::new()),native_bridge:Mutex::new(integration::NativeBridge::default())});
        #[cfg(feature="e2e")]
        if let Some(window)=app.get_webview_window("main") {window.hide()?;}
        Ok(())
    }).on_window_event(|window,event| {
        if let tauri::WindowEvent::CloseRequested {api,..}=event {
            api.prevent_close();
            let handle=window.app_handle().clone();
            let window=window.clone();
            std::thread::spawn(move || {
                let app=handle.state::<App>();
                let result=(||->Result<()> {
                    let running=app.running.lock().map_err(task_error)?;
                    if !running.is_empty() {return Err(Error::new("job_active","A REA or agent task is active. Cancel it or wait for completion before closing Studio."));}
                    app.native_bridge.lock().map_err(task_error)?.close()?;
                    window.destroy().map_err(task_error)?;
                    Ok(())
                })();
                if let Err(e)=result {let _=window.emit("studio:close-blocked",json!({"message":e.message}));}
            });
        }
    })
      .invoke_handler(tauri::generate_handler![has_active_task,get_agent_settings,save_agent_settings,pick_agent_file,detect_agent,agent_conversations,new_agent_conversation,agent_turns,agent_context,start_agent_turn,cancel_agent_turn,get_settings,pick_connection_file,detect_connection,list_projects,import_target,rename_project,delete_project,list_jobs,job_logs,start_analysis,cancel_analysis,search_entities,graph_view,entity_kinds,inspect_evidence,inspect_source,export_data])
      .run(tauri::generate_context!()).expect("REA Studio could not start");
}
