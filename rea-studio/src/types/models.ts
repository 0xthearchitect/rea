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
}
export interface Project {
  id: string;
  name: string;
  target: string;
  created_at: number;
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
