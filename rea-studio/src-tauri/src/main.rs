#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod integration;
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
}
fn task_error(e: impl std::fmt::Display) -> Error {
    Error::new("internal", e.to_string())
}
#[tauri::command]
fn get_settings(app: State<'_, App>) -> Result<Settings> {
    let mut settings = app.store.settings()?;
    if cfg!(debug_assertions) {
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
                _ => return Err(Error::new("unsupported_target", "Choose directory or ASAR")),
            }
        };
        path.map(|p| app.state::<App>().store.create_project(&name, &p))
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
        let jobs=state.store.jobs(&project_id)?;
        let confirmed=rfd::MessageDialog::new().set_title("Delete investigation?").set_description("This removes Studio metadata and saved Evidence for this project. Your original target is preserved.").set_buttons(rfd::MessageButtons::YesNo).show();
        if confirmed!=rfd::MessageDialogResult::Yes {return Ok(false);}
        let root=state.store.root.join("jobs").canonicalize()?;
        for job in jobs { let path=state.store.job_dir(&job.id)?; if path.exists() { let resolved=path.canonicalize()?; if !resolved.starts_with(&root) || resolved==root {return Err(Error::new("invalid_path","Evidence storage ownership could not be established"));} std::fs::remove_dir_all(&resolved)?; } }
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
            let result = integration::run(
                &settings,
                &bridge,
                json!({"action":"analyze","target":target,"output":dir.join("evidence.json"),"projection":dir.join("projection.json"),"source_paths":source_paths}),
                input,
                |message| {
                    let _ = store.log(&job, &message);
                    let _ = app.emit(
                        "studio:activity",
                        Activity {
                            job_id: job.clone(),
                            message,
                            at: now(),
                        },
                    );
                },
            )?;
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
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<App>();
        let evidence = state.store.evidence(&job_id, &entity_id)?;
        let facts = &evidence.facts;
        let mut candidate = None;
        if let Some(observations) = facts["observations"].as_array() {
            for observation in observations {
                let ev = &observation["evidence"];
                if ev["artifact"]["available"] == true && ev["location"]["available"] == true {
                    let loc = &ev["location"]["value"];
                    let path = match loc["kind"].as_str() {
                        Some("artifact-path") => loc["path"].as_str(),
                        Some("source-range") => loc["source"].as_str(),
                        _ => None,
                    };
                    if let (Some(p), Some(hash)) = (path, ev["artifact"]["sha256"].as_str()) {
                        candidate = Some((p.to_owned(), hash.to_owned()));
                        break;
                    }
                }
            }
        }
        let (relative, digest) = candidate.ok_or_else(|| {
            Error::new(
                "evidence_unavailable",
                "This entity has no available source path and artifact digest",
            )
        })?;
        let target: String = state.store.db()?.query_row(
            "SELECT p.target FROM projects p JOIN jobs j ON j.project_id=p.id WHERE j.id=?1",
            [job_id],
            |r| r.get(0),
        )?;
        security::verified_source(Path::new(&target), &relative, &digest)
    })
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
        let mut output = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)?;
        match format.as_str() {
            "evidence" => {
                let mut source =
                    std::fs::File::open(state.store.job_dir(&job_id)?.join("evidence.json"))?;
                std::io::copy(&mut source, &mut output)?;
            }
            "graph" => {
                serde_json::to_writer(&mut output, &state.store.graph(&job_id, &focus)?)?;
            }
            _ => return Err(Error::new("invalid_request", "Unsupported export format")),
        }
        output.sync_all()?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(task_error)?
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
        let bridge=if cfg!(debug_assertions) {Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/bridge.mjs")} else {app.path().resource_dir()?.join("resources/bridge.mjs")};
        app.manage(App {_workspace_lock:workspace_lock,store,bridge,running:Mutex::new(HashMap::new())});
        #[cfg(feature="e2e")]
        if let Some(window)=app.get_webview_window("main") {window.hide()?;}
        Ok(())
    }).on_window_event(|window,event| { if let tauri::WindowEvent::CloseRequested {api,..}=event {let app=window.state::<App>(); if app.running.lock().map(|r|!r.is_empty()).unwrap_or(true) {api.prevent_close(); let _=window.emit("studio:close-blocked",json!({"message":"An analysis is active. Cancel it or wait for completion before closing Studio."}));} } })
      .invoke_handler(tauri::generate_handler![get_settings,pick_connection_file,detect_connection,list_projects,import_target,rename_project,delete_project,list_jobs,job_logs,start_analysis,cancel_analysis,search_entities,graph_view,entity_kinds,inspect_evidence,inspect_source,export_data])
      .run(tauri::generate_context!()).expect("REA Studio could not start");
}
