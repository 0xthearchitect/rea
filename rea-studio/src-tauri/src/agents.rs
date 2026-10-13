use crate::{models::*, storage::Store};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentSettings {
    pub executable: String,
    pub model: String,
}
#[derive(Serialize)]
pub struct Conversation {
    pub id: String,
    pub project_id: String,
    pub created_at: i64,
}
#[derive(Serialize)]
pub struct AgentTurn {
    pub id: String,
    pub question: String,
    pub answer: String,
    pub context: Value,
    pub state: String,
    pub model: Option<String>,
    pub model_provider: Option<String>,
    pub usage: Value,
    pub created_at: i64,
    pub finished_at: Option<i64>,
    pub message: String,
    pub activity: Vec<Activity>,
    pub evidence: Vec<Value>,
    pub authority: &'static str,
}
impl Store {
    pub fn agent_settings(&self) -> Result<AgentSettings> {
        use rusqlite::OptionalExtension;
        let text: Option<String> = self
            .db()?
            .query_row("SELECT value FROM settings WHERE key='agent'", [], |r| {
                r.get(0)
            })
            .optional()?;
        match text {
            Some(text) => Ok(serde_json::from_str(&text)?),
            None => Ok(AgentSettings::default()),
        }
    }
    pub fn save_agent_settings(&self, settings: &AgentSettings) -> Result<()> {
        if !settings.executable.is_empty()
            && (!PathBuf::from(&settings.executable).is_absolute()
                || !PathBuf::from(&settings.executable).is_file())
        {
            return Err(Error::new(
                "missing_dependency",
                "Choose an existing absolute trusted Codex executable",
            ));
        }
        if settings.model.len() > 200 || settings.model.contains('\0') {
            return Err(Error::new("invalid_request", "Invalid model identifier"));
        }
        let db = self.db()?;
        db.execute("INSERT OR IGNORE INTO settings(key,value) SELECT 'agent_backup',value FROM settings WHERE key='agent'",[])?;
        db.execute("INSERT INTO settings VALUES('agent',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[serde_json::to_string(settings)?])?;
        Ok(())
    }
    pub fn conversations(&self, project: &str) -> Result<Vec<Conversation>> {
        let db = self.db()?;
        let mut q=db.prepare("SELECT id,project_id,created_at FROM agent_conversations WHERE project_id=?1 ORDER BY created_at DESC,rowid DESC")?;
        let rows = q.query_map([project], |r| {
            Ok(Conversation {
                id: r.get(0)?,
                project_id: r.get(1)?,
                created_at: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    pub fn new_conversation(&self, project: &str) -> Result<String> {
        self.target(project)?;
        let id = uuid::Uuid::new_v4().to_string();
        self.db()?.execute(
            "INSERT INTO agent_conversations VALUES(?1,?2,?3)",
            params![id, project, now()],
        )?;
        Ok(id)
    }
    pub fn agent_dir(&self, turn: &str) -> Result<PathBuf> {
        uuid::Uuid::parse_str(turn)
            .map_err(|_| Error::new("invalid_request", "Invalid agent turn identity"))?;
        Ok(self.root.join("agents").join(turn))
    }
    pub fn agent_context(&self, project: &str, job: &str, entity: &str) -> Result<Value> {
        let target = self.target(project)?;
        let selected = if job.is_empty() {
            Value::Null
        } else {
            let owner: String =
                self.db()?
                    .query_row("SELECT project_id FROM jobs WHERE id=?1", [job], |r| {
                        r.get(0)
                    })?;
            if owner != project {
                return Err(Error::new(
                    "invalid_request",
                    "Selected Evidence belongs to another project",
                ));
            }
            let evidence = self.evidence(job, entity)?;
            json!({"job_id":job,"entity_id":entity,"record":evidence.header,"facts":evidence.facts,"limitations":evidence.limitations})
        };
        let context = json!({"target":target,"workflow":self.workflow(project)?,"selected_evidence":selected});
        if serde_json::to_vec(&context)?.len() > 128 * 1024 {
            return Err(Error::new("resource_constraint","Selected context exceeds 128 KiB; choose a smaller finding or omit the attachment. Complete Evidence stays local."));
        }
        Ok(context)
    }
    pub fn begin_agent(
        &self,
        conversation: &str,
        question: &str,
        context: &Value,
    ) -> Result<(String, String, Value)> {
        if question.trim().is_empty() || question.len() > 32768 || question.contains('\0') {
            return Err(Error::new(
                "invalid_request",
                "Question requires 1–32768 bytes without NUL",
            ));
        }
        let db = self.db()?;
        let project: String = db.query_row(
            "SELECT project_id FROM agent_conversations WHERE id=?1",
            [conversation],
            |r| r.get(0),
        )?;
        let mut q=db.prepare("SELECT question,answer FROM agent_turns WHERE conversation_id=?1 AND state='completed' ORDER BY created_at,rowid")?;
        let rows = q.query_map([conversation], |r| {
            Ok(json!({"question":r.get::<_,String>(0)?,"answer":r.get::<_,String>(1)?}))
        })?;
        let mut history = Vec::new();
        let mut bytes = serde_json::to_vec(context)?.len();
        for row in rows {
            let row = row?;
            bytes += serde_json::to_vec(&row)?.len();
            if bytes > 128 * 1024 || history.len() >= 100 {
                return Err(Error::new("resource_constraint","Conversation exceeds the context bound. Start a new conversation; previous messages remain saved."));
            }
            history.push(row);
        }
        let id = uuid::Uuid::new_v4().to_string();
        std::fs::create_dir_all(self.agent_dir(&id)?)?;
        db.execute("INSERT INTO agent_turns(id,conversation_id,question,context,state,created_at) VALUES(?1,?2,?3,?4,'running',?5)",params![id,conversation,question,serde_json::to_string(context)?,now()])?;
        Ok((id, project, json!(history)))
    }
    pub fn agent_event(&self, turn: &str, project: &str, event: &Value) -> Result<()> {
        let db = self.db()?;
        match event["type"].as_str() {
            Some("message") => {
                let text = event["text"].as_str().ok_or_else(|| {
                    Error::new("malformed_response", "Agent message missing text")
                })?;
                if text.len() > 1024 * 1024 {
                    return Err(Error::new(
                        "resource_constraint",
                        "Agent transcript exceeds 1 MiB",
                    ));
                }
                db.execute(
                    "UPDATE agent_turns SET answer=?2 WHERE id=?1",
                    params![turn, text],
                )?;
            }
            Some("activity") => {
                let text = event["message"].as_str().ok_or_else(|| {
                    Error::new("malformed_response", "Agent activity missing message")
                })?;
                let bounded: String = text.chars().take(8192).collect();
                db.execute(
                    "INSERT INTO agent_activity VALUES(?1,?2,?3)",
                    params![turn, now(), bounded],
                )?;
            }
            Some("session") => {
                db.execute(
                    "UPDATE agent_turns SET model=?2,model_provider=?3,thread_id=?4 WHERE id=?1",
                    params![
                        turn,
                        event["model"].as_str(),
                        event["model_provider"].as_str(),
                        event["thread_id"].as_str()
                    ],
                )?;
            }
            Some("usage") => {
                db.execute(
                    "UPDATE agent_turns SET usage=?2 WHERE id=?1",
                    params![turn, serde_json::to_string(&event["usage"])?],
                )?;
            }
            Some("analysis") => {
                let id = event["id"]
                    .as_str()
                    .ok_or_else(|| Error::new("malformed_response", "Missing analysis identity"))?;
                let source = self.agent_dir(turn)?.join("analyses").join(id);
                let destination = self.job_dir(id)?;
                let root = self.agent_dir(turn)?.canonicalize()?;
                let resolved = source.canonicalize()?;
                if !resolved.starts_with(&root) || resolved == root {
                    return Err(Error::new(
                        "invalid_path",
                        "Agent analysis storage ownership is unknown",
                    ));
                }
                if event["projection"].as_str() != source.join("projection.json").to_str()
                    || event["raw_path"].as_str() != source.join("evidence.json").to_str()
                {
                    return Err(Error::new(
                        "invalid_path",
                        "Agent receipt does not identify its owned analysis files",
                    ));
                }
                if std::fs::metadata(source.join("evidence.json"))?.len() > 64 * 1024 * 1024 {
                    return Err(Error::new(
                        "resource_constraint",
                        "Original agent Evidence exceeds the indexing bound",
                    ));
                }
                std::fs::create_dir(&destination)?;
                db.execute(
                    "INSERT INTO jobs(id,project_id,state,started_at) VALUES(?1,?2,'indexing',?3)",
                    params![id, project, now()],
                )?;
                std::fs::copy(
                    source.join("evidence.json"),
                    destination.join("evidence.json"),
                )?;
                let version = event["version"]
                    .as_str()
                    .ok_or_else(|| Error::new("malformed_response", "Missing REA version"))?;
                self.index(id, version, &source.join("projection.json"))?;
                let original: String =
                    db.query_row("SELECT evidence_id FROM jobs WHERE id=?1", [id], |r| {
                        r.get(0)
                    })?;
                if event["evidence_id"].as_str() != Some(&original) {
                    return Err(Error::new(
                        "malformed_response",
                        "Agent Evidence identity changed during indexing",
                    ));
                }
                db.execute(
                    "INSERT INTO agent_evidence VALUES(?1,?2,?3)",
                    params![turn, id, original],
                )?;
            }
            _ => return Err(Error::new("malformed_response", "Unknown agent event")),
        }
        Ok(())
    }
    pub fn finish_agent(&self, turn: &str, result: &Value) -> Result<()> {
        let state = result["status"]
            .as_str()
            .filter(|s| matches!(*s, "completed" | "failed" | "interrupted"))
            .ok_or_else(|| Error::new("malformed_response", "Agent terminal state missing"))?;
        let answer = result["answer"]
            .as_str()
            .ok_or_else(|| Error::new("malformed_response", "Agent final answer missing"))?;
        if answer.len() > 1024 * 1024 {
            return Err(Error::new(
                "resource_constraint",
                "Agent answer exceeds 1 MiB",
            ));
        }
        let message = if result["error"].is_null() {
            String::new()
        } else {
            serde_json::to_string(&result["error"])?
        };
        self.db()?.execute("UPDATE agent_turns SET state=?2,answer=?3,usage=?4,finished_at=?5,message=?6 WHERE id=?1",params![turn,state,answer,serde_json::to_string(&result["usage"])?,now(),message])?;
        // The original copies now belong to indexed jobs. Keep failed/unindexed
        // artifacts until the user deletes their project; remove only superseded copies.
        let db = self.db()?;
        let mut q = db.prepare("SELECT job_id FROM agent_evidence WHERE turn_id=?1")?;
        for row in q.query_map([turn], |r| r.get::<_, String>(0))? {
            let path = self.agent_dir(turn)?.join("analyses").join(row?);
            if path.exists() {
                if let Err(error) = std::fs::remove_dir_all(&path) {
                    // Keep the known path under this turn's ownership; a failed
                    // janitor must not rewrite a completed model response.
                    self.agent_event(turn,"",&json!({"type":"activity","message":format!("Answer saved; superseded analysis copies remain at {}: {error}",path.display())}))?;
                }
            }
        }
        Ok(())
    }
    pub fn fail_agent(&self, turn: &str, error: &Error) -> Result<()> {
        self.db()?.execute(
            "UPDATE agent_turns SET state=?2,finished_at=?3,message=?4 WHERE id=?1",
            params![
                turn,
                if error.code == "cancelled_unverified" || error.code == "cleanup_unknown" {
                    "interrupted"
                } else {
                    "failed"
                },
                now(),
                error.message
            ],
        )?;
        Ok(())
    }
    pub fn agent_turns(&self, conversation: &str, offset: i64) -> Result<Value> {
        if !(0..=1000000).contains(&offset) {
            return Err(Error::new("invalid_request", "Invalid conversation offset"));
        }
        let db = self.db()?;
        let total: i64 = db.query_row(
            "SELECT count(*) FROM agent_turns WHERE conversation_id=?1",
            [conversation],
            |r| r.get(0),
        )?;
        let mut q=db.prepare("SELECT id,question,answer,context,state,model,model_provider,usage,created_at,finished_at,message FROM agent_turns WHERE conversation_id=?1 ORDER BY created_at DESC,rowid DESC LIMIT 5 OFFSET ?2")?;
        let rows = q.query_map(params![conversation, offset], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, i64>(8)?,
                r.get::<_, Option<i64>>(9)?,
                r.get::<_, String>(10)?,
            ))
        })?;
        let mut items = Vec::new();
        for row in rows {
            let (
                id,
                question,
                answer,
                context,
                state,
                model,
                model_provider,
                usage,
                created_at,
                finished_at,
                message,
            ) = row?;
            let mut a=db.prepare("SELECT at,message FROM agent_activity WHERE turn_id=?1 ORDER BY rowid DESC LIMIT 20")?;
            let activity = a
                .query_map([&id], |r| {
                    Ok(Activity {
                        job_id: id.clone(),
                        at: r.get(0)?,
                        message: r.get(1)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let mut e =
                db.prepare("SELECT job_id,evidence_id FROM agent_evidence WHERE turn_id=?1")?;
            let evidence = e
                .query_map([&id], |r| {
                    Ok(json!({"job_id":r.get::<_,String>(0)?,"evidence_id":r.get::<_,String>(1)?}))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            items.push(AgentTurn {
                id,
                question,
                answer,
                context: serde_json::from_str(&context)?,
                state,
                model,
                model_provider,
                usage: usage
                    .map(|v| serde_json::from_str(&v))
                    .transpose()?
                    .unwrap_or(Value::Null),
                created_at,
                finished_at,
                message,
                activity,
                evidence,
                authority: "analyst-inference",
            });
        }
        Ok(
            json!({"items":items,"total":total,"offset":offset,"next_offset":if offset+5<total {Some(offset+5)}else{None}}),
        )
    }
    pub fn agent_turn_ids(&self, project: &str) -> Result<Vec<String>> {
        let db = self.db()?;
        let mut q=db.prepare("SELECT t.id FROM agent_turns t JOIN agent_conversations c ON c.id=t.conversation_id WHERE c.project_id=?1")?;
        let rows = q.query_map([project], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn conversations_preserve_scope_and_restart_marks_only_unfinished_turns() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path().join("store")).unwrap();
        let target = root.path().join("application");
        std::fs::create_dir(&target).unwrap();
        let project = store
            .create_project("Agent fixture", &target, "javascript")
            .unwrap();
        let conversation = store.new_conversation(&project.id).unwrap();
        let context = store.agent_context(&project.id, "", "").unwrap();
        let (id, _, history) = store
            .begin_agent(&conversation, "Question one", &context)
            .unwrap();
        assert_eq!(history, json!([]));
        store
            .agent_event(
                &id,
                &project.id,
                &json!({"type":"message","text":"A partial answer"}),
            )
            .unwrap();
        store.finish_agent(&id,&json!({"status":"completed","answer":"Answer with explicit unknowns","usage":null,"error":null})).unwrap();
        let (next, _, history) = store
            .begin_agent(&conversation, "Question two", &context)
            .unwrap();
        assert_eq!(history[0]["answer"], "Answer with explicit unknowns");
        drop(store);
        let reopened = Store::open(root.path().join("store")).unwrap();
        let page = reopened.agent_turns(&conversation, 0).unwrap();
        assert_eq!(page["items"][0]["id"], next);
        assert_eq!(page["items"][0]["state"], "interrupted");
        assert_eq!(page["items"][1]["state"], "completed");
        assert_eq!(page["items"][1]["authority"], "analyst-inference");
        let second = reopened
            .create_project("Other project", &target, "javascript")
            .unwrap();
        let (job, _) = reopened.begin_job(&second.id).unwrap();
        assert_eq!(
            reopened
                .agent_context(&project.id, &job, "")
                .unwrap_err()
                .code,
            "invalid_request"
        );
        assert!(reopened
            .begin_agent(&conversation, &"x".repeat(32769), &context)
            .is_err());
    }
    #[test]
    fn schema_two_upgrade_has_one_consistent_backup_and_preserves_rows() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path().join("store")).unwrap();
        let target = root.path().join("app");
        std::fs::create_dir(&target).unwrap();
        let project = store
            .create_project("Preserved", &target, "javascript")
            .unwrap();
        store.db().unwrap().execute_batch("DROP TABLE agent_evidence;DROP TABLE agent_activity;DROP TABLE agent_turns;DROP TABLE agent_conversations;PRAGMA user_version=2;").unwrap();
        drop(store);
        let store = Store::open(root.path().join("store")).unwrap();
        assert_eq!(store.projects().unwrap()[0].id, project.id);
        assert_eq!(
            store
                .db()
                .unwrap()
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            3
        );
        let backups = || {
            std::fs::read_dir(&store.root)
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .starts_with("studio-v2-backup-")
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(backups().len(), 1);
        let backup = rusqlite::Connection::open(backups()[0].path()).unwrap();
        assert_eq!(
            backup
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
        Store::open(store.root.clone()).unwrap();
        assert_eq!(backups().len(), 1);
    }
    #[test]
    #[ignore = "Requires STUDIO_AGENT_TEST_ROOT from verify-agent.mjs"]
    fn genuine_agent_tool_evidence_indexes_and_survives_restart() {
        let artifacts = PathBuf::from(std::env::var("STUDIO_AGENT_TEST_ROOT").unwrap());
        let events: Vec<Value> =
            serde_json::from_slice(&std::fs::read(artifacts.join("agent-events.json")).unwrap())
                .unwrap();
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path().join("store")).unwrap();
        let project = store
            .create_project("Real agent", &artifacts.join("application"), "javascript")
            .unwrap();
        let conversation = store.new_conversation(&project.id).unwrap();
        let context = store.agent_context(&project.id, "", "").unwrap();
        let (turn, _, _) = store
            .begin_agent(&conversation, "Explain fixture", &context)
            .unwrap();
        for event in &events {
            if event["type"] != "agent_event" {
                continue;
            }
            let mut value = event["value"].clone();
            if value["type"] == "analysis" {
                let id = value["id"].as_str().unwrap();
                let source = store.agent_dir(&turn).unwrap().join("analyses").join(id);
                std::fs::create_dir_all(&source).unwrap();
                std::fs::copy(
                    value["raw_path"].as_str().unwrap(),
                    source.join("evidence.json"),
                )
                .unwrap();
                std::fs::copy(
                    value["projection"].as_str().unwrap(),
                    source.join("projection.json"),
                )
                .unwrap();
                value["raw_path"] = json!(source.join("evidence.json"));
                value["projection"] = json!(source.join("projection.json"));
            }
            store.agent_event(&turn, &project.id, &value).unwrap();
        }
        let result: Value =
            serde_json::from_slice(&std::fs::read(artifacts.join("result.json")).unwrap()).unwrap();
        store.finish_agent(&turn, &result).unwrap();
        assert_eq!(store.jobs(&project.id).unwrap().len(), 1);
        let page = store.agent_turns(&conversation, 0).unwrap();
        let original = page["items"][0]["evidence"][0]["evidence_id"]
            .as_str()
            .unwrap();
        assert!(result["answer"].as_str().unwrap().contains(original));
        drop(store);
        let store = Store::open(root.path().join("store")).unwrap();
        assert_eq!(
            store.agent_turns(&conversation, 0).unwrap()["items"][0]["state"],
            "completed"
        );
        assert_eq!(
            store.agent_turns(&conversation, 0).unwrap()["items"][0]["authority"],
            "analyst-inference"
        );
    }
}
