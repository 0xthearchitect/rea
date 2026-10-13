use crate::models::*;
use crate::security::{read_bounded, MAX_BUNDLE};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
#[derive(Clone)]
pub struct Store {
    pub root: PathBuf,
}
impl Store {
    pub fn open(root: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(root.join("jobs"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))?;
        }
        let store = Self { root };
        let db = store.db()?;
        let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > 3 {
            return Err(Error::new(
                "incompatible_storage",
                "This workspace uses a newer schema. Use its original Studio version.",
            ));
        }
        if version == 0 {
            db.execute_batch("BEGIN; CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,target TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,state TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,version TEXT,evidence_id TEXT,message TEXT NOT NULL DEFAULT '',node_count INTEGER NOT NULL DEFAULT 0,edge_count INTEGER NOT NULL DEFAULT 0,coverage TEXT NOT NULL DEFAULT 'unknown',header TEXT,limitations TEXT,target_sha256 TEXT);
CREATE TABLE IF NOT EXISTS entities(job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,id TEXT NOT NULL,label TEXT NOT NULL,kind TEXT NOT NULL,evidence_id TEXT NOT NULL,facts TEXT NOT NULL,PRIMARY KEY(job_id,id));
CREATE INDEX IF NOT EXISTS entities_kind ON entities(job_id,kind,label);
CREATE TABLE IF NOT EXISTS edges(job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,id TEXT NOT NULL,source TEXT NOT NULL,target TEXT NOT NULL,relation TEXT NOT NULL,evidence TEXT NOT NULL,PRIMARY KEY(job_id,id));
CREATE INDEX IF NOT EXISTS edges_source ON edges(job_id,source); CREATE INDEX IF NOT EXISTS edges_target ON edges(job_id,target);
CREATE TABLE IF NOT EXISTS logs(job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,at INTEGER NOT NULL,message TEXT NOT NULL);
PRAGMA user_version=1; COMMIT;")?;
        }
        if version <= 1 {
            // A consistent SQLite backup includes committed WAL contents. Never overwrite a backup.
            if version == 1 {
                let backup = store
                    .root
                    .join(format!("studio-v1-backup-{}.sqlite", uuid::Uuid::new_v4()));
                db.execute(
                    "VACUUM INTO ?1",
                    [backup.to_str().ok_or_else(|| {
                        Error::new("invalid_encoding", "Backup path cannot be represented")
                    })?],
                )?;
            }
            db.execute_batch("BEGIN; ALTER TABLE projects ADD COLUMN workflow TEXT NOT NULL DEFAULT 'javascript' CHECK(workflow IN ('javascript','native'));
CREATE TABLE evidence_records(job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,evidence_id TEXT NOT NULL,header TEXT NOT NULL,PRIMARY KEY(job_id,evidence_id));
PRAGMA user_version=2; COMMIT;")?;
        }
        if version <= 2 {
            if version == 2 {
                let backup = store
                    .root
                    .join(format!("studio-v2-backup-{}.sqlite", uuid::Uuid::new_v4()));
                db.execute(
                    "VACUUM INTO ?1",
                    [backup.to_str().ok_or_else(|| {
                        Error::new("invalid_encoding", "Backup path cannot be represented")
                    })?],
                )?;
            }
            db.execute_batch("BEGIN;
CREATE TABLE agent_conversations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,created_at INTEGER NOT NULL);
CREATE TABLE agent_turns(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,question TEXT NOT NULL,answer TEXT NOT NULL DEFAULT '',context TEXT NOT NULL,state TEXT NOT NULL,model TEXT,model_provider TEXT,usage TEXT,thread_id TEXT,created_at INTEGER NOT NULL,finished_at INTEGER,message TEXT NOT NULL DEFAULT '');
CREATE TABLE agent_activity(turn_id TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,at INTEGER NOT NULL,message TEXT NOT NULL);
CREATE TABLE agent_evidence(turn_id TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,evidence_id TEXT NOT NULL,PRIMARY KEY(turn_id,job_id));
PRAGMA user_version=3; COMMIT;")?;
            db.execute_batch("CREATE INDEX IF NOT EXISTS agent_turns_conversation ON agent_turns(conversation_id,created_at);")?;
        }
        db.execute("UPDATE agent_turns SET state='interrupted',finished_at=?1,message='Studio stopped before the agent reported a terminal state. Cleanup is unknown.' WHERE state IN ('running','cancellation_requested')",[now()])?;
        db.execute("UPDATE jobs SET state='interrupted',finished_at=?1,message='Studio stopped before a terminal result was recorded. Upstream cleanup is unknown.' WHERE state IN ('running','cancellation_requested','indexing')", [now()])?;
        Ok(store)
    }
    pub fn db(&self) -> Result<Connection> {
        let db = Connection::open(self.root.join("studio.sqlite"))?;
        db.busy_timeout(Duration::from_secs(10))?;
        db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")?;
        Ok(db)
    }
    pub fn settings(&self) -> Result<Settings> {
        let db = self.db()?;
        let text = db
            .query_row(
                "SELECT value FROM settings WHERE key='connection'",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        match text {
            Some(value) => Ok(serde_json::from_str(&value)?),
            None => Ok(Settings::default()),
        }
    }
    pub fn save_settings(&self, settings: &Settings) -> Result<()> {
        let db = self.db()?;
        db.execute("INSERT OR IGNORE INTO settings(key,value) SELECT 'connection_backup',value FROM settings WHERE key='connection'", [])?;
        db.execute("INSERT INTO settings VALUES('connection',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [serde_json::to_string(settings)?])?;
        Ok(())
    }
    pub fn create_project(&self, name: &str, target: &Path, workflow: &str) -> Result<Project> {
        let selected_target = target
            .to_str()
            .ok_or_else(|| {
                Error::new(
                    "invalid_encoding",
                    "The selected path cannot be represented without changing its value",
                )
            })?
            .to_owned();
        let target = target.canonicalize()?;
        if !matches!(workflow, "javascript" | "native") {
            return Err(Error::new(
                "invalid_request",
                "Unknown investigation workflow",
            ));
        }
        if workflow == "native" && !target.is_file() {
            return Err(Error::new(
                "unsupported_target",
                "Native analysis requires a selected binary file",
            ));
        }
        if workflow == "javascript"
            && !target.is_dir()
            && target
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| !s.eq_ignore_ascii_case("asar"))
                .unwrap_or(true)
        {
            return Err(Error::new(
                "unsupported_target",
                "Choose a JavaScript application directory or ASAR",
            ));
        }
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 120 {
            return Err(Error::new(
                "invalid_request",
                "Project names require 1–120 characters",
            ));
        }
        let project = Project {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            target: selected_target,
            created_at: now(),
            workflow: workflow.to_owned(),
        };
        self.db()?.execute(
            "INSERT INTO projects(id,name,target,created_at,workflow) VALUES(?1,?2,?3,?4,?5)",
            params![
                project.id,
                project.name,
                project.target,
                project.created_at,
                project.workflow
            ],
        )?;
        Ok(project)
    }
    pub fn projects(&self) -> Result<Vec<Project>> {
        let db = self.db()?;
        let mut q = db.prepare(
            "SELECT id,name,target,created_at,workflow FROM projects ORDER BY created_at DESC",
        )?;
        let rows = q.query_map([], |r| {
            Ok(Project {
                id: r.get(0)?,
                name: r.get(1)?,
                target: r.get(2)?,
                created_at: r.get(3)?,
                workflow: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    pub fn jobs(&self, project: &str) -> Result<Vec<Job>> {
        let db = self.db()?;
        let mut q = db.prepare("SELECT id,project_id,state,started_at,finished_at,version,evidence_id,message,node_count,edge_count,coverage FROM jobs WHERE project_id=?1 ORDER BY started_at DESC")?;
        let rows = q.query_map([project], |r| {
            Ok(Job {
                id: r.get(0)?,
                project_id: r.get(1)?,
                state: r.get(2)?,
                started_at: r.get(3)?,
                finished_at: r.get(4)?,
                version: r.get(5)?,
                evidence_id: r.get(6)?,
                message: r.get(7)?,
                node_count: r.get(8)?,
                edge_count: r.get(9)?,
                coverage: r.get(10)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    pub fn target(&self, project: &str) -> Result<String> {
        Ok(self
            .db()?
            .query_row("SELECT target FROM projects WHERE id=?1", [project], |r| {
                r.get(0)
            })?)
    }
    pub fn workflow(&self, project: &str) -> Result<String> {
        Ok(self.db()?.query_row(
            "SELECT workflow FROM projects WHERE id=?1",
            [project],
            |r| r.get(0),
        )?)
    }
    pub fn job_dir(&self, job: &str) -> Result<PathBuf> {
        uuid::Uuid::parse_str(job)
            .map_err(|_| Error::new("invalid_request", "Invalid job identity"))?;
        Ok(self.root.join("jobs").join(job))
    }
    pub fn begin_job(&self, project: &str) -> Result<(String, String)> {
        let target = self.target(project)?;
        let id = uuid::Uuid::new_v4().to_string();
        std::fs::create_dir(self.job_dir(&id)?)?;
        self.db()?.execute("INSERT INTO jobs(id,project_id,state,started_at,message) VALUES(?1,?2,'running',?3,'Connecting to REA')",params![id,project,now()])?;
        Ok((id, target))
    }
    pub fn log(&self, job: &str, message: &str) -> Result<()> {
        let db = self.db()?;
        let truncated: String = message.chars().take(8192).collect();
        db.execute(
            "INSERT INTO logs VALUES(?1,?2,?3)",
            params![job, now(), truncated],
        )?;
        db.execute("DELETE FROM logs WHERE job_id=?1 AND rowid NOT IN (SELECT rowid FROM logs WHERE job_id=?1 ORDER BY rowid DESC LIMIT 200)",[job])?;
        db.execute(
            "UPDATE jobs SET message=?2 WHERE id=?1",
            params![job, truncated],
        )?;
        Ok(())
    }
    pub fn logs(&self, job: &str) -> Result<Vec<Activity>> {
        let db = self.db()?;
        let mut q = db
            .prepare("SELECT at,message FROM logs WHERE job_id=?1 ORDER BY rowid DESC LIMIT 200")?;
        let rows = q.query_map([job], |r| {
            Ok(Activity {
                job_id: job.into(),
                at: r.get(0)?,
                message: r.get(1)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    pub fn finish_error(&self, job: &str, error: &str, interrupted: bool) -> Result<()> {
        self.log(job, error)?;
        self.db()?.execute(
            "UPDATE jobs SET state=?2,finished_at=?3,message=?4 WHERE id=?1",
            params![
                job,
                if interrupted { "interrupted" } else { "failed" },
                now(),
                error
            ],
        )?;
        Ok(())
    }
    pub fn index(&self, job: &str, version: &str, path: &Path) -> Result<()> {
        let projected: Projection = serde_json::from_slice(&read_bounded(path, MAX_BUNDLE * 2)?)?;
        let db = self.db()?;
        let project_target: String = db.query_row(
            "SELECT p.target FROM projects p JOIN jobs j ON j.project_id=p.id WHERE j.id=?1",
            [job],
            |r| r.get(0),
        )?;
        if Path::new(&projected.input_path).canonicalize()?
            != Path::new(&project_target).canonicalize()?
        {
            return Err(Error::new(
                "target_mismatch",
                "REA returned another target identity",
            ));
        }
        db.execute(
            "UPDATE jobs SET state='indexing',message='Indexing retained Evidence' WHERE id=?1",
            [job],
        )?;
        let mut db = db;
        let tx = db.transaction()?;
        {
            let mut q = tx.prepare("INSERT INTO evidence_records VALUES(?1,?2,?3)")?;
            for record in &projected.records {
                if record.header["evidence_id"].as_str() != Some(&record.evidence_id) {
                    return Err(Error::new(
                        "malformed_response",
                        "Record header identity mismatch",
                    ));
                }
                q.execute(params![
                    job,
                    record.evidence_id,
                    serde_json::to_string(&record.header)?
                ])?;
            }
        }
        {
            let mut q = tx.prepare("INSERT INTO entities VALUES(?1,?2,?3,?4,?5,?6)")?;
            for n in &projected.nodes {
                if n.facts["studio_format"] == "native-v1"
                    && !projected
                        .records
                        .iter()
                        .any(|record| record.evidence_id == n.evidence_id)
                {
                    return Err(Error::new(
                        "malformed_response",
                        "Native finding has no retained record header",
                    ));
                }
                q.execute(params![
                    job,
                    n.id,
                    n.label,
                    n.kind,
                    n.evidence_id,
                    serde_json::to_string(&n.facts)?
                ])?;
            }
        }
        {
            let mut q = tx.prepare("INSERT INTO edges VALUES(?1,?2,?3,?4,?5,?6)")?;
            for e in &projected.edges {
                q.execute(params![
                    job,
                    e.id,
                    e.source,
                    e.target,
                    e.relation,
                    serde_json::to_string(&e.evidence)?
                ])?;
            }
        }
        tx.execute("UPDATE jobs SET state='succeeded',finished_at=?2,version=?3,evidence_id=?4,node_count=?5,edge_count=?6,coverage=?7,header=?8,limitations=?9,target_sha256=?10,message='Complete original Evidence saved; local index ready' WHERE id=?1", params![job,now(),version,projected.evidence_id,projected.nodes.len() as i64,projected.edges.len() as i64,projected.coverage,serde_json::to_string(&projected.header)?,serde_json::to_string(&projected.limitations)?,projected.target_sha256])?;
        tx.commit()?;
        Ok(())
    }
    pub fn page(
        &self,
        job: &str,
        search: &str,
        kind: &str,
        offset: i64,
        limit: i64,
    ) -> Result<Page> {
        if offset < 0 || !(1..=200).contains(&limit) || search.len() > 1024 {
            return Err(Error::new(
                "invalid_request",
                "Page bounds are offset ≥ 0, limit 1–200, search ≤ 1024 bytes",
            ));
        }
        let db = self.db()?;
        let filter = "job_id=?1 AND (?2='' OR instr(lower(label),lower(?2))>0 OR instr(lower(id),lower(?2))>0 OR instr(lower(facts),lower(?2))>0) AND (?3='' OR kind=?3)";
        let total = db.query_row(
            &format!("SELECT count(*) FROM entities WHERE {filter}"),
            params![job, search, kind],
            |r| r.get(0),
        )?;
        let mut q = db.prepare(&format!("SELECT id,label,kind,evidence_id FROM entities WHERE {filter} ORDER BY label,id LIMIT ?4 OFFSET ?5"))?;
        let rows = q.query_map(params![job, search, kind, limit, offset], entity_row)?;
        Ok(Page {
            items: rows.collect::<std::result::Result<_, _>>()?,
            total,
        })
    }
    pub fn graph(&self, job: &str, focus: &str) -> Result<Graph> {
        let db = self.db()?;
        let (total_nodes, total_edges, coverage) = db.query_row(
            "SELECT node_count,edge_count,coverage FROM jobs WHERE id=?1",
            [job],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )?;
        let mut q = db.prepare("SELECT id,label,kind,evidence_id FROM entities WHERE job_id=?1 AND (?2='' OR id=?2 OR id IN (SELECT target FROM edges WHERE job_id=?1 AND source=?2) OR id IN (SELECT source FROM edges WHERE job_id=?1 AND target=?2)) ORDER BY CASE WHEN id=?2 THEN 0 ELSE 1 END,label,id LIMIT 300")?;
        let rows = q.query_map(params![job, focus], entity_row)?;
        let nodes: Vec<Entity> = rows.collect::<std::result::Result<_, _>>()?;
        let ids: std::collections::HashSet<_> = nodes.iter().map(|n| n.id.as_str()).collect();
        let mut q =
            db.prepare("SELECT id,source,target,relation FROM edges WHERE job_id=?1 ORDER BY id")?;
        let rows = q.query_map([job], |r| {
            Ok(Edge {
                id: r.get(0)?,
                source: r.get(1)?,
                target: r.get(2)?,
                relation: r.get(3)?,
                evidence: json!(null),
            })
        })?;
        let mut edges = Vec::new();
        let mut omitted = false;
        for row in rows {
            let edge = row?;
            if ids.contains(edge.source.as_str()) && ids.contains(edge.target.as_str()) {
                if edges.len() < 800 {
                    edges.push(edge);
                } else {
                    omitted = true;
                    break;
                }
            }
        }
        let limited =
            omitted || (nodes.len() as i64) < total_nodes || (edges.len() as i64) < total_edges;
        Ok(Graph {
            nodes,
            edges,
            total_nodes,
            total_edges,
            coverage,
            limited,
        })
    }
    pub fn evidence(&self, job: &str, id: &str) -> Result<Evidence> {
        let db = self.db()?;
        let (header, limitations): (String, String) = db.query_row(
            "SELECT header,limitations FROM jobs WHERE id=?1",
            [job],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let selected = if id.is_empty() {
            None
        } else {
            Some(db.query_row("SELECT facts,evidence_id FROM entities WHERE job_id=?1 AND id=?2 UNION ALL SELECT e.evidence,j.evidence_id FROM edges e JOIN jobs j ON j.id=e.job_id WHERE e.job_id=?1 AND e.id=?2",params![job,id],|r|Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?)))?)
        };
        let header = match &selected {
            Some((_, evidence_id)) => db
                .query_row(
                    "SELECT header FROM evidence_records WHERE job_id=?1 AND evidence_id=?2",
                    params![job, evidence_id],
                    |r| r.get::<_, String>(0),
                )
                .optional()?
                .unwrap_or(header),
            None => header,
        };
        let header_bytes = header.len();
        let facts_bytes = selected.as_ref().map_or(0, |(s, _)| s.len());
        if header_bytes + facts_bytes > 2 * 1024 * 1024 {
            return Err(Error::new("resource_constraint", "This entity exceeds the 2 MiB inspector bound. Export original Evidence for full inspection."));
        }
        let header: Value = serde_json::from_str(&header)?;
        let mut facts: Value = selected
            .map(|(s, _)| serde_json::from_str(&s))
            .transpose()?
            .unwrap_or(Value::Null);
        let native = if facts["studio_format"] == "native-v1" {
            // Header metadata can appear in the record, common inspector and native view.
            // Account for its expansion before cloning it into the response.
            if header_bytes * 3 + facts_bytes > 2 * 1024 * 1024 {
                return Err(Error::new("resource_constraint", "Native inspector metadata exceeds the 2 MiB response budget. Export original Evidence for full inspection."));
            }
            let mut view = facts["view"].clone();
            let object = view.as_object_mut().ok_or_else(|| {
                Error::new(
                    "malformed_response",
                    "Native display projection is not an object",
                )
            })?;
            object.insert("record".into(), json!({"confidence":header["confidence"].as_str(),"authority":header["authority"].as_str(),"provider":header["provider"]["name"].as_str()}));
            object.insert("limitations".into(), header["limitations"].clone());
            facts = facts["value"].clone();
            Some(view)
        } else {
            None
        };
        let limitations: Value = if native.is_some() {
            header["limitations"].clone()
        } else {
            serde_json::from_str(&limitations)?
        };
        let mut inspection = crate::presentation::inspect(&header, &facts, &limitations);
        if let Some(view) = &native {
            inspection.label = view["title"].as_str().map(str::to_owned);
        }
        Ok(Evidence {
            inspection,
            header,
            facts,
            raw_path: self
                .job_dir(job)?
                .join("evidence.json")
                .to_string_lossy()
                .into_owned(),
            limitations,
            native,
        })
    }
    pub fn source(&self, job: &str, entity: &str) -> Result<String> {
        let evidence = self.evidence(job, entity)?;
        if evidence.native.is_some() {
            return Err(Error::new("unsupported", "Native pseudocode is decompiler-generated, not original source. Open Code & references."));
        }
        let candidate = evidence.facts["observations"]
            .as_array()
            .and_then(|observations| {
                observations.iter().find_map(|observation| {
                    let ev = &observation["evidence"];
                    if ev["artifact"]["available"] != true || ev["location"]["available"] != true {
                        return None;
                    }
                    let loc = &ev["location"]["value"];
                    let path = match loc["kind"].as_str() {
                        Some("artifact-path") => loc["path"].as_str(),
                        Some("source-range") => loc["source"].as_str(),
                        _ => None,
                    }?;
                    Some((path, ev["artifact"]["sha256"].as_str()?))
                })
            });
        let (relative, digest) = candidate.ok_or_else(|| {
            Error::new(
                "evidence_unavailable",
                "This entity has no available source path and artifact digest",
            )
        })?;
        let target: String = self.db()?.query_row(
            "SELECT p.target FROM projects p JOIN jobs j ON j.project_id=p.id WHERE j.id=?1",
            [job],
            |r| r.get(0),
        )?;
        crate::security::verified_source(Path::new(&target), relative, digest)
    }
    pub fn kinds(&self, job: &str) -> Result<Vec<String>> {
        let db = self.db()?;
        let mut q =
            db.prepare("SELECT DISTINCT kind FROM entities WHERE job_id=?1 ORDER BY kind")?;
        let rows = q.query_map([job], |r| r.get(0))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
}
fn entity_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Entity> {
    Ok(Entity {
        id: r.get(0)?,
        label: r.get(1)?,
        kind: r.get(2)?,
        evidence_id: r.get(3)?,
        facts: json!(null),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migration_backs_up_old_workspaces_once_and_rejects_newer_schemas() {
        let d = tempfile::tempdir().unwrap();
        let target = d.path().join("app");
        std::fs::create_dir(&target).unwrap();
        let store = Store::open(d.path().join("store")).unwrap();
        let project = store
            .create_project("Existing investigation", &target, "javascript")
            .unwrap();
        {
            let db = store.db().unwrap();
            db.execute_batch("DROP TABLE agent_evidence; DROP TABLE agent_activity; DROP TABLE agent_turns; DROP TABLE agent_conversations; ALTER TABLE projects DROP COLUMN workflow; DROP TABLE evidence_records; PRAGMA user_version=1;").unwrap();
        }
        let reopened = Store::open(store.root.clone()).unwrap();
        assert_eq!(reopened.projects().unwrap()[0].id, project.id);
        assert_eq!(reopened.projects().unwrap()[0].workflow, "javascript");
        let backups: Vec<_> = std::fs::read_dir(&store.root)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("studio-v1-backup-")
            })
            .collect();
        assert_eq!(backups.len(), 1);
        let backup = Connection::open(&backups[0]).unwrap();
        assert_eq!(
            backup
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            backup
                .query_row("SELECT id FROM projects", [], |r| r.get::<_, String>(0))
                .unwrap(),
            project.id
        );
        Store::open(store.root.clone()).unwrap();
        assert_eq!(
            std::fs::read_dir(&store.root)
                .unwrap()
                .filter(|e| e
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("studio-v1-backup-"))
                .count(),
            1
        );
        reopened
            .db()
            .unwrap()
            .execute_batch("PRAGMA user_version=99")
            .unwrap();
        let error = match Store::open(store.root) {
            Ok(_) => panic!("newer schema admitted"),
            Err(e) => e,
        };
        assert_eq!(error.code, "incompatible_storage");
    }
    #[test]
    #[ignore = "Requires STUDIO_NATIVE_TEST_PROJECTION from scripts/verify-native.mjs"]
    fn real_native_finding_preserves_record_provenance_and_reopens() {
        let path = PathBuf::from(std::env::var("STUDIO_NATIVE_TEST_PROJECTION").unwrap());
        let parsed: Projection =
            serde_json::from_slice(&read_bounded(&path, MAX_BUNDLE * 2).unwrap()).unwrap();
        let d = tempfile::tempdir().unwrap();
        let store = Store::open(d.path().join("store")).unwrap();
        let project = store
            .create_project(
                "Native investigation",
                Path::new(&parsed.input_path),
                "native",
            )
            .unwrap();
        assert!(store
            .create_project(
                "Wrong workflow",
                Path::new(&parsed.input_path),
                "javascript"
            )
            .is_err());
        let (job, _) = store.begin_job(&project.id).unwrap();
        store.index(&job, "6.4.0", &path).unwrap();
        let page = store.page(&job, "main", "native-function", 0, 200).unwrap();
        let entity = &page.items[0];
        let evidence = store.evidence(&job, &entity.id).unwrap();
        assert_eq!(evidence.header["evidence_id"], entity.evidence_id);
        assert_eq!(evidence.header["operation"], "analyze_function");
        assert_eq!(
            evidence.header["subject"]["digest"]["sha256"],
            parsed.target_sha256
        );
        assert!(evidence.native.as_ref().unwrap()["code"]
            .as_str()
            .unwrap()
            .contains("calculate_total"));
        assert_eq!(
            store.source(&job, &entity.id).unwrap_err().code,
            "unsupported"
        );
        let reopened = Store::open(store.root).unwrap();
        assert_eq!(reopened.projects().unwrap()[0].workflow, "native");
        assert_eq!(
            reopened.evidence(&job, &entity.id).unwrap().header,
            evidence.header
        );
        assert_eq!(reopened.jobs(&project.id).unwrap()[0].state, "succeeded");
        // This header fits the stored input bound, but repeated provider metadata
        // would expand beyond the response budget. Reject it before cloning.
        let mut oversized_header = evidence.header;
        oversized_header["provider"]["name"] = json!("x".repeat(800 * 1024));
        reopened
            .db()
            .unwrap()
            .execute(
                "UPDATE evidence_records SET header=?3 WHERE job_id=?1 AND evidence_id=?2",
                params![
                    job,
                    entity.evidence_id,
                    serde_json::to_string(&oversized_header).unwrap()
                ],
            )
            .unwrap();
        let error = match reopened.evidence(&job, &entity.id) {
            Ok(_) => panic!("oversized native response admitted"),
            Err(error) => error,
        };
        assert_eq!(error.code, "resource_constraint");
    }
    #[test]
    fn restart_retains_projects_and_interrupts_unfinished_jobs() {
        let d = tempfile::tempdir().unwrap();
        let target = d.path().join("app");
        std::fs::create_dir(&target).unwrap();
        let store = Store::open(d.path().join("store")).unwrap();
        let p = store
            .create_project("Research", &target, "javascript")
            .unwrap();
        store.begin_job(&p.id).unwrap();
        let reopened = Store::open(store.root).unwrap();
        assert_eq!(reopened.projects().unwrap()[0].target, p.target);
        assert_eq!(reopened.jobs(&p.id).unwrap()[0].state, "interrupted");
        assert!(reopened.page("unknown", "", "", -1, 10).is_err());
    }
    #[test]
    #[ignore = "Requires STUDIO_TEST_PROJECTION produced by scripts/verify-live.mjs"]
    fn real_evidence_survives_index_search_graph_and_restart() {
        let projection = PathBuf::from(
            std::env::var("STUDIO_TEST_PROJECTION").expect("Run the live verifier first"),
        );
        let parsed: Projection =
            serde_json::from_slice(&read_bounded(&projection, MAX_BUNDLE * 2).unwrap()).unwrap();
        let d = tempfile::tempdir().unwrap();
        let store = Store::open(d.path().join("store")).unwrap();
        let p = store
            .create_project("Real workflow", Path::new(&parsed.input_path), "javascript")
            .unwrap();
        let (job, _) = store.begin_job(&p.id).unwrap();
        store.index(&job, "6.4.0", &projection).unwrap();
        let page = store.page(&job, "parser", "", 0, 200).unwrap();
        assert!(page.total > 0);
        assert!(page.items.iter().any(|e| e.label.contains("parser")));
        let graph = store.graph(&job, "").unwrap();
        assert!(graph.edges.iter().any(|e| e.relation == "imports"));
        assert_eq!(graph.total_nodes, parsed.nodes.len() as i64);
        assert_eq!(graph.total_edges, parsed.edges.len() as i64);
        assert_eq!(graph.nodes.len(), parsed.nodes.len().min(300));
        assert!(graph.edges.len() <= 800);
        let loaded: std::collections::HashSet<_> =
            graph.nodes.iter().map(|n| n.id.as_str()).collect();
        let eligible = parsed
            .edges
            .iter()
            .filter(|e| loaded.contains(e.source.as_str()) && loaded.contains(e.target.as_str()))
            .count();
        assert_eq!(graph.edges.len(), eligible.min(800));
        println!(
            "Real Evidence graph: {}/{} nodes, {}/{} edges, limited={}",
            graph.nodes.len(),
            graph.total_nodes,
            graph.edges.len(),
            graph.total_edges,
            graph.limited
        );
        assert_eq!(
            graph.limited,
            graph.nodes.len() < parsed.nodes.len() || graph.edges.len() < parsed.edges.len()
        );
        let focus = &page
            .items
            .iter()
            .find(|e| e.label.contains("parser.js"))
            .unwrap()
            .id;
        let neighborhood = store.graph(&job, focus).unwrap();
        assert!(neighborhood.nodes.iter().any(|n| &n.id == focus));
        for n in &neighborhood.nodes {
            assert!(
                &n.id == focus
                    || parsed
                        .edges
                        .iter()
                        .any(|e| (&e.source == focus && e.target == n.id)
                            || (&e.target == focus && e.source == n.id))
            );
        }
        for e in &graph.edges {
            assert!(graph.nodes.iter().any(|n| n.id == e.source));
            assert!(graph.nodes.iter().any(|n| n.id == e.target));
        }
        if Path::new(&parsed.input_path).is_dir() {
            assert_eq!(
                store.source(&job, focus).unwrap(),
                std::fs::read_to_string(Path::new(&parsed.input_path).join("parser.js")).unwrap()
            );
        } else {
            assert_eq!(store.source(&job, focus).unwrap_err().code, "unsupported");
        }
        let evidence = store.evidence(&job, &page.items[0].id).unwrap();
        assert_eq!(evidence.header["evidence_id"], parsed.evidence_id);
        assert!(evidence.facts["observations"].is_array());
        let reopened = Store::open(store.root).unwrap();
        assert_eq!(reopened.jobs(&p.id).unwrap()[0].state, "succeeded");
        assert_eq!(
            reopened.page(&job, "parser", "", 0, 200).unwrap().total,
            page.total
        );
        if Path::new(&parsed.input_path).is_dir() {
            assert!(reopened
                .source(&job, focus)
                .unwrap()
                .contains("decodeRecord"));
        }
    }
}
