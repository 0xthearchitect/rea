use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}
impl Error {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::new("io", e.to_string())
    }
}
impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Self::new("storage", e.to_string())
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Self::new("malformed_response", e.to_string())
    }
}
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    pub node: String,
    pub rea: String,
}
#[derive(Serialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub target: String,
    pub created_at: i64,
}
#[derive(Serialize)]
pub struct Job {
    pub id: String,
    pub project_id: String,
    pub state: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub version: Option<String>,
    pub evidence_id: Option<String>,
    pub message: String,
    pub node_count: i64,
    pub edge_count: i64,
    pub coverage: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Entity {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub evidence_id: String,
    pub facts: Value,
}
#[derive(Serialize, Deserialize)]
pub struct Edge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub relation: String,
    pub evidence: Value,
}
#[derive(Serialize)]
pub struct Page {
    pub items: Vec<Entity>,
    pub total: i64,
}
#[derive(Serialize)]
pub struct Graph {
    pub nodes: Vec<Entity>,
    pub edges: Vec<Edge>,
    pub total_nodes: i64,
    pub total_edges: i64,
    pub coverage: String,
    pub limited: bool,
}
#[derive(Serialize)]
pub struct Evidence {
    pub inspection: Inspection,
    pub header: Value,
    pub facts: Value,
    pub raw_path: String,
    pub limitations: Value,
}
#[derive(Serialize)]
pub struct Inspection {
    pub label: Option<String>,
    pub kind: Option<String>,
    pub evidence_id: Option<String>,
    pub operation: Option<String>,
    pub provider: Option<String>,
    pub state: Option<String>,
    pub authority: Option<String>,
    pub coverage: Option<String>,
    pub location: Value,
    pub properties: Value,
    pub limitations: Value,
}
#[derive(Serialize, Clone)]
pub struct Activity {
    pub job_id: String,
    pub message: String,
    pub at: i64,
}
#[derive(Deserialize)]
pub struct Projection {
    pub evidence_id: String,
    pub header: Value,
    pub nodes: Vec<Entity>,
    pub edges: Vec<Edge>,
    pub target_sha256: String,
    pub input_path: String,
    pub coverage: String,
    pub limitations: Value,
}
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
