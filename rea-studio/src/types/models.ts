export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export interface Settings {
  node: string;
  rea: string;
}
export interface Connection {
  state:
    | "connected"
    | "disconnected"
    | "incompatible"
    | "missing_dependency"
    | "error";
  version: string | null;
  cli: boolean;
  mcp: boolean;
  can_analyze: boolean;
  supports_source_paths: boolean;
  message: string;
  tools: { name: string; inputSchema: Json; outputSchema?: Json }[];
  providers: Json;
  native?: {
    can_open: boolean;
    providers: {
      id: string;
      name: string;
      version: string | null;
      available: boolean | null;
      reason: string | null;
    }[];
    operations: {
      operation: NativeOperation;
      name: string;
      advertised: boolean;
      available: boolean | null;
      reason: string | null;
    }[];
  };
}
export type NativeOperation =
  | "overview"
  | "procedures"
  | "strings"
  | "function"
  | "instructions"
  | "references"
  | "instruction";
export interface NativeRequest {
  operation: NativeOperation;
  provider_id?: string;
  query: string;
}
export interface NativeView {
  title: string;
  record?: {
    confidence: string | null;
    authority: string | null;
    provider: string | null;
  };
  procedure?: string;
  provider_selection?: { provider_id?: string };
  actions?: { label: string; operation: NativeOperation; query: string }[];
  limitations?: string[];
  fields: { label: string; value: Json }[];
  code?: string;
  assembly?: string[];
  tables?: {
    title: string;
    columns: string[];
    rows: Json[][];
    links?: { operation: NativeOperation; query: string }[];
  }[];
}
export interface Project {
  id: string;
  name: string;
  target: string;
  created_at: number;
  workflow: "javascript" | "native";
}
export interface Job {
  id: string;
  project_id: string;
  state: string;
  started_at: number;
  finished_at: number | null;
  version: string | null;
  evidence_id: string | null;
  message: string;
  node_count: number;
  edge_count: number;
  coverage: string;
}
export interface Entity {
  id: string;
  label: string;
  kind: string;
  evidence_id: string;
  facts: Json;
}
export interface Edge {
  id: string;
  source: string;
  target: string;
  relation: string;
  evidence: Json;
}
export interface Page {
  items: Entity[];
  total: number;
}
export interface Graph {
  nodes: Entity[];
  edges: Edge[];
  total_nodes: number;
  total_edges: number;
  coverage: string;
  limited: boolean;
}
export interface Evidence {
  native: NativeView | null;
  inspection: {
    label: string | null;
    kind: string | null;
    evidence_id: string | null;
    operation: string | null;
    provider: string | null;
    state: string | null;
    authority: string | null;
    coverage: string | null;
    location: Json;
    properties: Json;
    limitations: Json;
  };
  header: Json;
  facts: Json;
  raw_path: string;
  limitations: Json;
}
export interface Activity {
  job_id: string;
  message: string;
  at: number;
}

export interface AgentSettings {
  executable: string;
  model: string;
}
export interface AgentConnection {
  available: boolean;
  authenticated: boolean;
  message: string;
}
export interface AgentConversation {
  id: string;
  project_id: string;
  created_at: number;
}
export interface AgentTurn {
  id: string;
  question: string;
  answer: string;
  context: Json;
  state: string;
  model: string | null;
  model_provider: string | null;
  usage: Json;
  created_at: number;
  finished_at: number | null;
  message: string;
  activity: Activity[];
  evidence: { job_id: string; evidence_id: string }[];
  authority: "analyst-inference";
}
export interface AgentTurnPage {
  items: AgentTurn[];
  total: number;
  offset: number;
  next_offset: number | null;
}
