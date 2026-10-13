import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  Settings,
  Connection,
  Project,
  Job,
  Page,
  Graph,
  Evidence,
  Activity,
} from "../types/models";
export const desktopAvailable = isTauri();
export function message(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error)
    return String(error.message);
  return String(error);
}
async function call<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!desktopAvailable)
    throw new Error(
      "Native operations require the REA Studio desktop app. This browser view has no REA connection.",
    );
  return invoke<T>(command, args);
}
export const api = {
  settings: () => call<Settings>("get_settings"),
  pickDependency: (field: "node" | "rea") =>
    call<Settings | null>("pick_connection_file", { field }),
  detect: () => call<Connection>("detect_connection"),
  projects: () => call<Project[]>("list_projects"),
  import: (name: string, format: string) =>
    call<Project | null>("import_target", { name, format }),
  rename: (projectId: string, name: string) =>
    call<void>("rename_project", { projectId, name }),
  delete: (projectId: string) => call<boolean>("delete_project", { projectId }),
  jobs: (projectId: string) => call<Job[]>("list_jobs", { projectId }),
  start: (projectId: string, sourcePaths: string[]) =>
    call<string>("start_analysis", { projectId, sourcePaths }),
  cancel: (jobId: string) => call<void>("cancel_analysis", { jobId }),
  logs: (jobId: string) => call<Activity[]>("job_logs", { jobId }),
  entities: (jobId: string, search: string, kind: string, offset: number) =>
    call<Page>("search_entities", { jobId, search, kind, offset, limit: 200 }),
  graph: (jobId: string, focus: string) =>
    call<Graph>("graph_view", { jobId, focus }),
  kinds: (jobId: string) => call<string[]>("entity_kinds", { jobId }),
  evidence: (jobId: string, entityId: string) =>
    call<Evidence>("inspect_evidence", { jobId, entityId }),
  source: (jobId: string, entityId: string) =>
    call<string>("inspect_source", { jobId, entityId }),
  export: (jobId: string, format: "graph" | "evidence", focus = "") =>
    call<string | null>("export_data", { jobId, format, focus }),
};
