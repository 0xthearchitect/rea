import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { listen } from "@tauri-apps/api/event";
import {
  Activity,
  ArrowRight,
  Box,
  Braces,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Code2,
  Database,
  Download,
  FileCode2,
  FileSearch,
  Folder,
  FolderOpen,
  GitBranch,
  Layers,
  LoaderCircle,
  Maximize2,
  Moon,
  Network,
  PanelBottom,
  PanelRight,
  Play,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  Sun,
  Terminal,
  Trash2,
  Unplug,
  X,
} from "lucide-react";
import type { Entity, Job, NativeOperation } from "../types/models";
import { api, desktopAvailable, message } from "../integrations/desktop";
import { useWorkspace } from "../stores/workspace";
import type { View } from "../stores/workspace";
import {
  Badge,
  Button,
  Empty,
  Failure,
  Loading,
  Modal,
} from "../components/ui";
const GraphView = lazy(() => import("../features/graphs/GraphView"));
const CodeView = lazy(() => import("../features/editor/CodeView"));
const AgentView = lazy(() => import("../features/agents/AgentView"));
const NativeView = lazy(() => import("../features/native/NativeView"));
const nativeNames: Record<NativeOperation, string> = {
  overview: "Binary overview & sections",
  procedures: "Find functions",
  strings: "List strings",
  function: "Function dossier & pseudocode",
  instructions: "Function instructions",
  references: "References to address",
  instruction: "Inspect instruction or data address",
};
const icons: Record<string, ReactNode> = {
  findings: <Layers size={15} />,
  graph: <Network size={15} />,
  source: <Code2 size={15} />,
  evidence: <ShieldCheck size={15} />,
};
const viewNames: Record<View, string> = {
  findings: "Findings",
  graph: "Application graph",
  source: "Source inspection",
  evidence: "Evidence",
  connection: "REA connection",
  agent: "Agent workspace",
};
const activeStates = new Set(["running", "cancellation_requested", "indexing"]);
function pretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}
function elapsed(job: Job) {
  const seconds = Math.max(
    0,
    Math.floor(((job.finished_at ?? Date.now()) - job.started_at) / 1000),
  );
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function Resizer({ side }: { side: "left" | "right" | "bottom" }) {
  const set = useWorkspace((s) => s.set);
  return (
    <div
      className={`resizer ${side}`}
      role="separator"
      aria-label={`Resize ${side} panel`}
      aria-orientation={side === "bottom" ? "horizontal" : "vertical"}
      tabIndex={0}
      onKeyDown={(e) => {
        const delta =
          e.key === "ArrowRight" || e.key === "ArrowDown"
            ? 10
            : e.key === "ArrowLeft" || e.key === "ArrowUp"
              ? -10
              : 0;
        if (delta) {
          e.preventDefault();
          const current = useWorkspace.getState()[side];
          set({ [side]: Math.max(140, Math.min(600, current + delta)) });
        }
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const start = side === "bottom" ? e.clientY : e.clientX;
        const current = useWorkspace.getState()[side];
        const target = e.currentTarget;
        const move = (event: PointerEvent) => {
          const d = (side === "bottom" ? event.clientY : event.clientX) - start;
          set({
            [side]: Math.max(
              side === "bottom" ? 100 : 190,
              Math.min(
                side === "bottom" ? 420 : 500,
                current + (side === "left" ? d : -d),
              ),
            ),
          });
        };
        const end = () => {
          target.removeEventListener("pointermove", move);
          target.removeEventListener("pointerup", end);
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", end);
      }}
    />
  );
}

export default function App() {
  const ws = useWorkspace();
  const query = useQueryClient();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [importFormat, setImportFormat] = useState("directory");
  const [sourcePaths, setSourcePaths] = useState("");
  const [nativeOperation, setNativeOperation] =
    useState<NativeOperation>("overview");
  const [nativeProvider, setNativeProvider] = useState("");
  const [nativeQuery, setNativeQuery] = useState("");
  const [linkedJob, setLinkedJob] = useState<{
    id: string;
    project: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [kind, setKind] = useState("");
  const [offset, setOffset] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: api.projects,
    enabled: desktopAvailable,
  });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: api.settings,
    enabled: desktopAvailable,
  });
  const connection = useQuery({
    queryKey: ["connection"],
    queryFn: api.detect,
    enabled: desktopAvailable,
    staleTime: 30000,
  });
  const activeTask = useQuery({
    queryKey: ["active-task"],
    queryFn: api.hasActiveTask,
    enabled: desktopAvailable,
    refetchInterval: 1000,
  });
  const project = projects.data?.find((p) => p.id === ws.project);
  const isNative = project?.workflow === "native";
  const jobs = useQuery({
    queryKey: ["jobs", ws.project],
    queryFn: () => api.jobs(ws.project),
    enabled: !!project,
    refetchInterval: 1500,
  });
  const job = jobs.data?.find((j) => j.id === ws.job) ?? jobs.data?.[0];
  const completedJob =
    job?.state === "succeeded"
      ? job
      : jobs.data?.find((j) => j.state === "succeeded");
  const resultId = completedJob?.id ?? "";
  const running = jobs.data?.find((j) => activeStates.has(j.state));
  const kinds = useQuery({
    queryKey: ["kinds", resultId],
    queryFn: () => api.kinds(resultId),
    enabled: !!resultId,
    staleTime: Infinity,
  });
  useEffect(() => {
    if (kind && kinds.data && !kinds.data.includes(kind)) setKind("");
  }, [kind, kinds.data]);
  const entities = useQuery({
    queryKey: ["entities", resultId, debounced, kind, offset],
    queryFn: () => api.entities(resultId, debounced, kind, offset),
    enabled: !!resultId && ws.view === "findings",
    staleTime: Infinity,
  });
  const evidence = useQuery({
    queryKey: ["evidence", resultId, ws.selected],
    queryFn: () => api.evidence(resultId, ws.selected),
    enabled:
      !!resultId &&
      (ws.inspector || ws.view === "evidence" || ws.view === "source"),
    staleTime: Infinity,
  });
  const source = useQuery({
    queryKey: ["source", resultId, ws.selected],
    queryFn: () => api.source(resultId, ws.selected),
    enabled: !!resultId && !!ws.selected && ws.view === "source" && !isNative,
    staleTime: 0,
  });
  const logs = useQuery({
    queryKey: ["logs", job?.id],
    queryFn: () => api.logs(job!.id),
    enabled: !!job && ws.console,
    refetchInterval: running ? 1500 : false,
  });
  const select = useCallback(
    (id: string) =>
      useWorkspace.getState().set({ selected: id, inspector: true }),
    [],
  );
  useEffect(() => {
    document.documentElement.dataset.theme = ws.theme;
  }, [ws.theme]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setOffset(0);
    }, 220);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (
      projects.data?.length &&
      !projects.data.some((p) => p.id === ws.project)
    )
      ws.set({ project: projects.data[0]!.id, job: "", selected: "" });
  }, [projects.data, ws.project]);
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        ws.set({ view: "findings" });
        requestAnimationFrame(() => searchRef.current?.focus());
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "o") {
        e.preventDefault();
        setImportOpen(true);
      }
      if (e.key === "Escape") {
        setError("");
        setNotice("");
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [ws.set]);
  useEffect(() => {
    if (!desktopAvailable) return;
    const subscriptions = [
      listen("studio:job-finished", () => {
        void query.invalidateQueries({ queryKey: ["jobs"] });
        void query.invalidateQueries({ queryKey: ["logs"] });
      }),
      listen<{ message: string }>("studio:close-blocked", (e) =>
        setNotice(e.payload.message),
      ),
    ];
    return () => {
      for (const p of subscriptions) void p.then((unlisten) => unlisten());
    };
  }, [query]);
  async function action(fn: () => Promise<unknown>) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const status = !desktopAvailable
    ? "Desktop required"
    : connection.isFetching
      ? "Checking REA…"
      : connection.error
        ? "Connection error"
        : (connection.data?.state.replace("_", " ") ?? "Disconnected");
  const isConnected = connection.data?.state === "connected";
  const canRun =
    isConnected &&
    (isNative
      ? connection.data?.native?.can_open
      : connection.data?.can_analyze);
  const nativeOperationSupported =
    connection.data?.native?.operations.find(
      (o) => o.operation === nativeOperation,
    )?.advertised === true;
  async function followNative(operation: NativeOperation, address: string) {
    if (!project || running || activeTask.data === true || !canRun || busy)
      return;
    await action(async () => {
      const id = await api.start(project.id, [], {
        operation,
        query: address,
        ...(evidence.data?.native?.provider_selection ??
          (nativeProvider ? { provider_id: nativeProvider } : {})),
      });
      setLinkedJob({ id, project: project.id });
      setSearch("");
      setKind("");
      setOffset(0);
      ws.set({ job: id, selected: "", view: "findings", console: true });
      await query.invalidateQueries({ queryKey: ["jobs"] });
    });
  }
  useEffect(() => {
    if (!linkedJob) return;
    if (ws.project !== linkedJob.project || ws.job !== linkedJob.id) {
      setLinkedJob(null);
      return;
    }
    const linked = jobs.data?.find((j) => j.id === linkedJob.id);
    if (!linked || activeStates.has(linked.state)) return;
    if (linked.state !== "succeeded") {
      setError(linked.message);
      setLinkedJob(null);
      return;
    }
    let live = true;
    void api
      .entities(linked.id, "", "", 0)
      .then((page) => {
        if (live && page.items[0])
          ws.set({
            selected: page.items[0].id,
            view: "source",
            inspector: true,
          });
        if (live) setLinkedJob(null);
      })
      .catch((e) => {
        if (live) {
          setError(message(e));
          setLinkedJob(null);
        }
      });
    return () => {
      live = false;
    };
  }, [linkedJob, jobs.data, ws.project, ws.job]);
  const inspection = evidence.data?.inspection;
  const selectedLabel =
    inspection?.label ??
    (ws.selected ? "Selected entity" : "Analysis Evidence");
  const switchView = (view: View) => ws.set({ view });
  const importButton = (
    <Button
      variant="primary"
      disabled={!desktopAvailable || busy}
      onClick={() => {
        setProjectName("");
        setImportOpen(true);
      }}
    >
      <Plus size={15} />
      New investigation
    </Button>
  );

  return (
    <div
      className={`studio ${ws.view === "agent" ? "agent-mode" : ""}`}
      style={
        {
          "--explorer-width": `${ws.left}px`,
          "--inspector-width": `${ws.inspector ? ws.right : 0}px`,
          "--console-height": `${ws.console ? ws.bottom : 0}px`,
        } as CSSProperties
      }
    >
      <header className="titlebar">
        <div className="brand">
          <div className="brand-mark">
            <Braces size={22} />
          </div>
          <strong>
            REA<span>STUDIO</span>
          </strong>
          <Badge>LOCAL WORKSPACE</Badge>
        </div>
        <div className="titlebar-center">
          <Folder size={13} />
          {project?.name ?? "No investigation open"}
          <ChevronDown size={12} />
        </div>
        <div className="titlebar-actions">
          <button
            className="connection-pill"
            onClick={() => switchView("connection")}
          >
            <span className={`status-dot ${isConnected ? "online" : ""}`} />
            {status}
          </button>
          <Button
            variant="ghost"
            aria-label="Toggle color theme"
            onClick={() =>
              ws.set({ theme: ws.theme === "dark" ? "light" : "dark" })
            }
          >
            {ws.theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </Button>
        </div>
      </header>
      <nav className="activity-rail" aria-label="Workspace navigation">
        <button
          className={
            ws.view !== "connection" && ws.view !== "agent" ? "active" : ""
          }
          onClick={() => switchView("findings")}
          title="Investigations"
          aria-label="Investigations"
        >
          <FolderOpen size={21} />
        </button>
        <button
          className={ws.view === "graph" ? "active" : ""}
          onClick={() => switchView("graph")}
          title="Graph explorer"
          aria-label="Graph explorer"
        >
          <Network size={21} />
        </button>
        <button
          className={ws.view === "evidence" ? "active" : ""}
          onClick={() => switchView("evidence")}
          title="Evidence inspector"
          aria-label="Evidence inspector"
        >
          <ShieldCheck size={21} />
        </button>
        <button
          className={ws.view === "agent" ? "active" : ""}
          onClick={() => switchView("agent")}
          title="Agent workspace"
          aria-label="Agent workspace"
        >
          <Terminal size={21} />
        </button>
        <div className="grow" />
        <button
          className={ws.view === "connection" ? "active" : ""}
          onClick={() => switchView("connection")}
          title="Connection settings"
          aria-label="Connection settings"
        >
          <Settings2 size={21} />
        </button>
      </nav>
      <aside className="explorer">
        <div className="panel-heading">
          EXPLORER
          <Button
            variant="ghost"
            aria-label="New investigation"
            onClick={() => {
              setProjectName("");
              setImportOpen(true);
            }}
            disabled={!desktopAvailable}
          >
            <Plus size={15} />
          </Button>
        </div>
        <div className="explorer-section">
          <ChevronDown size={12} />
          INVESTIGATIONS
          <span className="grow" />
          <span className="count">{projects.data?.length ?? 0}</span>
        </div>
        {projects.isPending && desktopAvailable ? (
          <Loading label="Opening workspace…" />
        ) : projects.error ? (
          <Failure text={message(projects.error)} />
        ) : !projects.data?.length ? (
          <p className="sidebar-empty">
            Import an application to start an investigation.
          </p>
        ) : (
          projects.data.map((p) => (
            <button
              key={p.id}
              className={`tree-project ${p.id === ws.project ? "selected" : ""}`}
              onClick={() => {
                ws.set({
                  project: p.id,
                  job: "",
                  selected: "",
                  view: "findings",
                });
                setSearch("");
                setKind("");
                setOffset(0);
              }}
            >
              <FolderOpen size={15} />
              <span>{p.name}</span>
              {p.id === ws.project && <span className="status-dot online" />}
            </button>
          ))
        )}
        {project && (
          <>
            <div className="explorer-section">
              <ChevronDown size={12} />
              TARGET
            </div>
            <div className="target-file" title={project.target}>
              <FileCode2 size={16} />
              <div>
                <strong>{project.target.split(/[\\/]/).pop()}</strong>
                <span>Static analysis only</span>
              </div>
            </div>
            <div className="explorer-section">
              <ChevronDown size={12} />
              ANALYSIS DATA
            </div>
            {resultId ? (
              <>
                {kinds.data?.map((k) => (
                  <button
                    key={k}
                    className={`tree-item ${kind === k && ws.view === "findings" ? "selected" : ""}`}
                    onClick={() => {
                      setKind(k);
                      setOffset(0);
                      switchView("findings");
                    }}
                  >
                    <Box size={14} />
                    <span>{k}</span>
                  </button>
                ))}
                {!isNative && (
                  <button
                    className="tree-item"
                    onClick={() => switchView("graph")}
                  >
                    <GitBranch size={14} />
                    Application relationships
                  </button>
                )}
                <button
                  className="tree-item"
                  onClick={() => switchView("evidence")}
                >
                  <ShieldCheck size={14} />
                  Original Evidence
                </button>
              </>
            ) : (
              <p className="sidebar-empty">
                Sections appear when REA returns data.
              </p>
            )}
            <div className="explorer-section">
              <ChevronDown size={12} />
              ANALYSIS HISTORY
              <span className="grow" />
              <span className="count">{jobs.data?.length ?? 0}</span>
            </div>
            {jobs.data?.map((j) => (
              <button
                key={j.id}
                className={`history-item ${job?.id === j.id ? "selected" : ""}`}
                onClick={() => {
                  ws.set({ job: j.id, selected: "" });
                }}
              >
                <CircleDot size={13} />
                <span>
                  <strong>
                    {new Date(j.started_at).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </strong>
                  <small>
                    {j.state} ·{" "}
                    {j.version ? `REA ${j.version}` : "version pending"}
                  </small>
                </span>
              </button>
            ))}
            <div className="project-actions">
              <Button
                variant="ghost"
                onClick={() => {
                  setProjectName(project.name);
                  setRenameOpen(true);
                }}
              >
                Rename
              </Button>
              <Button
                variant="ghost"
                aria-label="Delete investigation"
                disabled={!!running || busy}
                onClick={() => {
                  void action(async () => {
                    if (await api.delete(project.id)) {
                      ws.set({ project: "", job: "", selected: "" });
                      await query.invalidateQueries({ queryKey: ["projects"] });
                    }
                  });
                }}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          </>
        )}
        <div className="explorer-footer">
          <ShieldCheck size={14} />
          <div>
            Local by design<span>Your targets stay on this device.</span>
          </div>
        </div>
        <Resizer side="left" />
      </aside>

      <main className="workspace">
        <div className="workspace-header">
          <div>
            <div className="eyebrow">INVESTIGATION WORKSPACE</div>
            <h1>
              {ws.view === "connection"
                ? "REA connection"
                : ws.view === "agent"
                  ? "Agent workspace"
                  : (project?.name ?? "Start with the evidence.")}
            </h1>
          </div>
          <div className="workspace-actions">
            {project && ws.view !== "connection" && (
              <Button
                variant="primary"
                disabled={!canRun || busy || !!running}
                onClick={() => setLaunchOpen(true)}
              >
                <Play size={14} />
                Run analysis
              </Button>
            )}
            <Button
              variant="ghost"
              title="Toggle inspector"
              aria-label="Toggle inspector"
              onClick={() => ws.set({ inspector: !ws.inspector })}
            >
              <PanelRight size={17} />
            </Button>
            <Button
              variant="ghost"
              title="Toggle jobs panel"
              aria-label="Toggle jobs panel"
              onClick={() => ws.set({ console: !ws.console })}
            >
              <PanelBottom size={17} />
            </Button>
          </div>
        </div>
        <div className="tabs" role="tablist" aria-label="Investigation views">
          {(isNative
            ? (["findings", "source", "evidence"] as const)
            : (["findings", "graph", "source", "evidence"] as const)
          ).map((view) => (
            <button
              key={view}
              role="tab"
              aria-selected={ws.view === view}
              className={ws.view === view ? "active" : ""}
              onClick={() => switchView(view)}
            >
              {icons[view]}
              {isNative && view === "source"
                ? "Code & references"
                : viewNames[view]}
              {view === "findings" && completedJob && (
                <span className="count">{completedJob.node_count}</span>
              )}
            </button>
          ))}
          <span className="grow" />
          {completedJob && (
            <span className="tab-context">
              REA {completedJob.version} · {completedJob.coverage} coverage
            </span>
          )}
        </div>
        {(error || notice) && (
          <div
            className={`feedback ${error ? "error" : ""}`}
            role={error ? "alert" : "status"}
          >
            <span>{error || notice}</span>
            <Button
              variant="ghost"
              aria-label="Dismiss message"
              onClick={() => {
                setError("");
                setNotice("");
              }}
            >
              <X size={14} />
            </Button>
          </div>
        )}
        <div className="workspace-content">
          {ws.view === "connection" ? (
            <div className="settings-view">
              <div className="settings-intro">
                <Unplug size={24} />
                <div>
                  <h2>Connect the analysis engine</h2>
                  <p>
                    Studio uses your local REA installation. Choose trusted
                    executable paths, then verify the live interfaces.
                  </p>
                </div>
              </div>
              <div className="settings-status">
                <span className={`status-dot ${isConnected ? "online" : ""}`} />
                <strong>{status}</strong>
                {connection.data?.version && (
                  <Badge>REA {connection.data.version}</Badge>
                )}
                <span className="grow" />
                <Button
                  disabled={!desktopAvailable || connection.isFetching}
                  onClick={() => {
                    void connection.refetch();
                  }}
                >
                  {connection.isFetching ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    <Activity size={14} />
                  )}
                  Check connection
                </Button>
              </div>
              {connection.data && (
                <p className="settings-message">{connection.data.message}</p>
              )}
              {connection.error && <Failure text={message(connection.error)} />}
              {!desktopAvailable && (
                <Failure text="This is a browser preview. Open the desktop application to use native file dialogs, SQLite, and real REA analysis." />
              )}
              <div className="setting-field">
                <label>Node executable</label>
                <code>{settings.data?.node || "Not configured"}</code>
                <Button
                  disabled={!desktopAvailable || busy}
                  onClick={() => {
                    void action(async () => {
                      await api.pickDependency("node");
                      await query.invalidateQueries({ queryKey: ["settings"] });
                      await connection.refetch();
                    });
                  }}
                >
                  Browse…
                </Button>
              </div>
              <div className="setting-field">
                <label>REA entrypoint</label>
                <code>
                  {settings.data?.rea || "Select the installed scripts/rea.mjs"}
                </code>
                <Button
                  disabled={!desktopAvailable || busy}
                  onClick={() => {
                    void action(async () => {
                      await api.pickDependency("rea");
                      await query.invalidateQueries({ queryKey: ["settings"] });
                      await connection.refetch();
                    });
                  }}
                >
                  Browse…
                </Button>
              </div>
              <div className="capability-grid">
                <div>
                  <Terminal size={17} />
                  <span>CLI interface</span>
                  <Badge tone={connection.data?.cli ? "green" : ""}>
                    {connection.data?.cli ? "Verified" : "Unverified"}
                  </Badge>
                </div>
                <div>
                  <Network size={17} />
                  <span>MCP stdio</span>
                  <Badge tone={connection.data?.mcp ? "green" : ""}>
                    {connection.data?.mcp ? "Verified" : "Unverified"}
                  </Badge>
                </div>
                <div>
                  <FileSearch size={17} />
                  <span>Static application analysis</span>
                  <Badge>
                    {connection.data?.can_analyze ? "Available" : "Unavailable"}
                  </Badge>
                </div>
                <div>
                  <Box size={17} />
                  <span>Live tool catalog</span>
                  <Badge>{connection.data?.tools.length ?? 0} tools</Badge>
                </div>
              </div>
              <h3>Native analysis providers</h3>
              {connection.data?.native?.providers.map((provider) => (
                <div className="setting-field" key={provider.id}>
                  <strong>
                    {provider.name} {provider.version ?? ""}
                  </strong>
                  <span>
                    {provider.reason ??
                      (provider.available
                        ? "Available; target support is checked when opening"
                        : "Availability unknown")}
                  </span>
                  <Badge tone={provider.available ? "green" : "amber"}>
                    {provider.available === null
                      ? "Unknown"
                      : provider.available
                        ? "Available"
                        : "Unavailable"}
                  </Badge>
                </div>
              ))}
              {!connection.data?.native?.providers.length && (
                <p className="muted">Native provider discovery unavailable.</p>
              )}
              <h3>Installation guidance</h3>
              <p>
                Use Node 24.18.0 and REA 6.4.x. For this source checkout, run{" "}
                <code>npm ci</code> and <code>npm run build:cached</code> in the
                REA directory, then select its <code>scripts/rea.mjs</code>.
                Studio never installs analysis providers.
              </p>
              <p className="muted">
                Upstream guidance: github.com/morluto/rea · docs/installation.md
              </p>
              {connection.data?.providers && (
                <details>
                  <summary>Actual provider and capability status</summary>
                  <pre>{pretty(connection.data.providers)}</pre>
                </details>
              )}
              {!!connection.data?.tools.length && (
                <details>
                  <summary>Advertised MCP tool contracts</summary>
                  <pre>{pretty(connection.data.tools)}</pre>
                </details>
              )}
            </div>
          ) : ws.view === "agent" ? (
            <Suspense fallback={<Loading />}>
              <AgentView
                key={ws.project}
                project={project}
                projects={projects.data ?? []}
                selectProject={(id) =>
                  ws.set({ project: id, job: "", selected: "" })
                }
                jobId={resultId}
                entityId={ws.selected}
                selectionLabel={selectedLabel}
                providerId={nativeProvider}
                setProvider={setNativeProvider}
                connection={connection.data}
                busyAnalysis={!!running || activeTask.data === true}
                openInvestigation={() => switchView("findings")}
                importProject={() => {
                  setProjectName("");
                  setImportOpen(true);
                }}
                openEvidence={(jobId) =>
                  ws.set({
                    job: jobId,
                    selected: "",
                    view: "evidence",
                    inspector: true,
                  })
                }
              />
            </Suspense>
          ) : !project ? (
            <div className="welcome">
              <div className="welcome-emblem">
                <Braces size={38} />
              </div>
              <div className="eyebrow">REVERSE ENGINEERING, WITH CONTEXT</div>
              <h2>
                Follow the connections.
                <br />
                <span>Keep the evidence.</span>
              </h2>
              <p>
                A local workspace for exploring software with REA.
                <br />
                Import a JavaScript application or ASAR to begin.
              </p>
              <div className="welcome-actions">
                {importButton}
                <Button onClick={() => switchView("connection")}>
                  <Settings2 size={15} />
                  Connection settings
                </Button>
              </div>
              <div className="onboarding">
                <div>
                  <span className="step">01</span>
                  <div>
                    <strong>Connect REA</strong>
                    <p>
                      {connection.isFetching
                        ? "Checking the local CLI and MCP server…"
                        : isConnected
                          ? `REA ${connection.data?.version} verified`
                          : "Check your local installation in settings."}
                    </p>
                  </div>
                  {isConnected && <ShieldCheck size={17} />}
                </div>
                <div>
                  <span className="step">02</span>
                  <div>
                    <strong>Import a target</strong>
                    <p>Opening an artifact never executes it.</p>
                  </div>
                </div>
                <div>
                  <span className="step">03</span>
                  <div>
                    <strong>Explore what REA finds</strong>
                    <p>
                      Search entities, navigate relationships, inspect their
                      origin.
                    </p>
                  </div>
                </div>
              </div>
              <div className="welcome-footnote">
                <Database size={14} />
                SQLite projects · Original Evidence on disk · No account
                required
              </div>
            </div>
          ) : !resultId ? (
            <Empty
              icon={
                running ? (
                  <LoaderCircle className="spin" size={30} />
                ) : (
                  <FileSearch size={32} />
                )
              }
              title={
                running
                  ? "REA is analyzing your target"
                  : "Ready for a real investigation"
              }
            >
              <p>
                {running?.message ??
                  (isNative
                    ? "Choose a native inspection task. REA checks the selected provider and target before analysis."
                    : "Run static analysis to populate findings and their application relationships.")}
              </p>
              {running ? (
                <Badge>
                  {elapsed(running)} elapsed · no estimated percentage
                </Badge>
              ) : (
                <Button
                  variant="primary"
                  disabled={!canRun || busy}
                  onClick={() => setLaunchOpen(true)}
                >
                  <Play size={14} />
                  Run static analysis
                </Button>
              )}
              {!isConnected && (
                <Button onClick={() => switchView("connection")}>
                  Configure REA connection
                  <ArrowRight size={14} />
                </Button>
              )}
              {job?.state === "failed" && <Failure text={job.message} />}
            </Empty>
          ) : ws.view === "findings" ? (
            <div className="findings-view">
              <div className="view-toolbar">
                {isNative && (
                  <Button
                    disabled={!ws.selected}
                    onClick={() => switchView("source")}
                  >
                    Open selected finding
                  </Button>
                )}
                <div className="search-input">
                  <Search size={15} />
                  <input
                    ref={searchRef}
                    aria-label="Search investigation"
                    placeholder="Search names, paths, properties, Evidence…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <kbd>Ctrl K</kbd>
                </div>
                <select
                  aria-label="Filter finding kind"
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value);
                    setOffset(0);
                  }}
                >
                  <option value="">All entity types</option>
                  {kinds.data?.map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </select>
              </div>
              {entities.isPending ? (
                <Loading />
              ) : entities.error ? (
                <Failure text={message(entities.error)} />
              ) : (
                <>
                  <VirtualEntities
                    items={entities.data.items}
                    selected={ws.selected}
                    select={select}
                  />
                  <div className="list-footer">
                    <span>
                      {entities.data.total ? offset + 1 : 0}–
                      {Math.min(
                        offset + entities.data.items.length,
                        entities.data.total,
                      )}{" "}
                      of {entities.data.total} matching entities
                    </span>
                    <span className="grow" />
                    <Button
                      variant="ghost"
                      disabled={!offset}
                      aria-label="Previous page"
                      onClick={() => setOffset(Math.max(0, offset - 200))}
                    >
                      <ChevronLeft size={15} />
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={offset + 200 >= entities.data.total}
                      aria-label="Next page"
                      onClick={() => setOffset(offset + 200)}
                    >
                      <ChevronRight size={15} />
                    </Button>
                  </div>
                </>
              )}
            </div>
          ) : isNative && (ws.view === "source" || ws.view === "graph") ? (
            !ws.selected ? (
              <Empty icon={<Code2 size={32} />} title="Select a native finding">
                <p>
                  Choose a function, string, section or inspection result from
                  Findings.
                </p>
              </Empty>
            ) : evidence.isPending ? (
              <Loading />
            ) : evidence.error ? (
              <Failure text={message(evidence.error)} />
            ) : evidence.data?.native ? (
              <Suspense fallback={<Loading />}>
                <NativeView
                  key={ws.selected}
                  view={evidence.data.native}
                  follow={(operation, address) =>
                    void followNative(operation, address)
                  }
                  disabled={
                    busy || !!running || activeTask.data === true || !canRun
                  }
                />
              </Suspense>
            ) : (
              <Failure text="This finding has no native display projection. Inspect its original Evidence." />
            )
          ) : ws.view === "graph" ? (
            <Suspense fallback={<Loading label="Opening graph explorer…" />}>
              <GraphView
                jobId={resultId}
                selectedIsNode={
                  !!inspection?.kind && inspection.kind !== "relationship"
                }
                selected={ws.selected}
                select={select}
              />
            </Suspense>
          ) : ws.view === "source" ? (
            !ws.selected ? (
              <Empty
                icon={<Code2 size={32} />}
                title="Select an entity to inspect its source"
              >
                <p>
                  Directory source is read only after its SHA-256 matches the
                  analyzed artifact. ASAR content remains accessible through the
                  original Evidence export.
                </p>
              </Empty>
            ) : source.isPending ? (
              <Loading label="Verifying source bytes against REA Evidence…" />
            ) : source.error ? (
              <Failure text={message(source.error)} />
            ) : (
              <div className="code-view">
                <div className="view-toolbar">
                  <FileCode2 size={14} />
                  <strong>{selectedLabel}</strong>
                  <Badge tone="green">Original source · digest verified</Badge>
                  <span className="grow" />
                  <Button
                    variant="ghost"
                    onClick={() => switchView("evidence")}
                  >
                    <ShieldCheck size={14} />
                    Evidence
                  </Button>
                </div>
                <Suspense fallback={<Loading />}>
                  <CodeView value={source.data} />
                </Suspense>
              </div>
            )
          ) : (
            <div className="evidence-view">
              <div className="view-toolbar">
                <ShieldCheck size={15} />
                <strong>Original REA provenance</strong>
                <span className="grow" />
                <Button
                  onClick={() => {
                    void action(async () => {
                      const path = await api.export(resultId, "evidence");
                      if (path)
                        setNotice(
                          `Complete original Evidence exported to ${path}`,
                        );
                    });
                  }}
                >
                  <Download size={14} />
                  Export complete bundle
                </Button>
              </div>
              {evidence.isPending ? (
                <Loading />
              ) : evidence.error ? (
                <Failure text={message(evidence.error)} />
              ) : (
                <div className="evidence-document">
                  <div className="eyebrow">REA EVIDENCE IDENTIFIER</div>
                  <code className="evidence-id">
                    {inspection?.evidence_id ?? "Unavailable"}
                  </code>
                  <p className="muted">
                    Complete original bundle: {evidence.data?.raw_path}
                  </p>
                  <h3>Record provenance</h3>
                  <pre>{pretty(evidence.data?.header)}</pre>
                  <h3>Selected finding or relationship</h3>
                  <pre>
                    {evidence.data?.facts === null
                      ? "No entity selected. Choose a finding or graph relationship to inspect its original observations."
                      : pretty(evidence.data?.facts)}
                  </pre>
                  <h3>Reported limitations</h3>
                  <pre>{pretty(evidence.data?.limitations)}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
      {ws.inspector && ws.view !== "agent" && (
        <aside className="inspector">
          <Resizer side="right" />
          <div className="panel-heading">
            INSPECTOR
            <Button
              variant="ghost"
              aria-label="Close inspector"
              onClick={() => ws.set({ inspector: false })}
            >
              <X size={14} />
            </Button>
          </div>
          {!resultId ? (
            <div className="inspector-empty">
              <CircleDot size={25} />
              <h3>Nothing selected yet</h3>
              <p>
                Select a finding or graph entity to inspect its properties and
                supporting Evidence.
              </p>
            </div>
          ) : evidence.isPending ? (
            <Loading />
          ) : evidence.error ? (
            <Failure text={message(evidence.error)} />
          ) : (
            <div className="inspector-body">
              <Badge>{inspection?.kind ?? "analysis"}</Badge>
              <h2>{selectedLabel}</h2>
              <code className="entity-id">
                {ws.selected || inspection?.evidence_id || "Unavailable"}
              </code>
              <div className="inspector-section">PROVENANCE</div>
              <dl>
                <dt>REA operation</dt>
                <dd>{inspection?.operation ?? "Unavailable"}</dd>
                <dt>Provider</dt>
                <dd>{inspection?.provider ?? "Unavailable"}</dd>
                <dt>Fact state</dt>
                <dd>
                  <Badge
                    tone={inspection?.state === "observed" ? "green" : "amber"}
                  >
                    {inspection?.state ?? "Unknown"}
                  </Badge>
                </dd>
                <dt>Authority</dt>
                <dd>{inspection?.authority ?? "Unknown"}</dd>
                <dt>Coverage</dt>
                <dd>{inspection?.coverage ?? "Unknown"}</dd>
              </dl>
              <div className="inspector-section">EVIDENCE</div>
              <code className="evidence-id">
                {inspection?.evidence_id ?? "Unavailable"}
              </code>
              <Button className="wide" onClick={() => switchView("evidence")}>
                <ShieldCheck size={14} />
                Inspect original provenance
                <ArrowRight size={14} />
              </Button>
              {ws.selected && (
                <Button className="wide" onClick={() => switchView("source")}>
                  <Code2 size={14} />
                  {isNative
                    ? "Inspect native code & details"
                    : "Inspect available source"}
                </Button>
              )}
              {isNative && evidence.data?.native?.procedure && (
                <Button
                  className="wide"
                  disabled={!canRun || !!running}
                  onClick={() => {
                    setNativeQuery(evidence.data!.native!.procedure!);
                    setNativeOperation("function");
                    setLaunchOpen(true);
                  }}
                >
                  Inspect this function
                </Button>
              )}
              <div className="inspector-section">SOURCE LOCATION</div>
              <pre className="small-pre">
                {pretty(inspection?.location ?? "Unavailable")}
              </pre>
              <div className="inspector-section">PROPERTIES</div>
              <pre className="small-pre">
                {pretty(inspection?.properties ?? "Unavailable")}
              </pre>
              <div className="inspector-section">LIMITATIONS</div>
              <pre className="small-pre">
                {pretty(inspection?.limitations ?? "Unknown")}
              </pre>
            </div>
          )}
        </aside>
      )}
      {ws.console && ws.view !== "agent" && (
        <section className="console">
          <Resizer side="bottom" />
          <div className="console-header">
            <Activity size={14} />
            <strong>Jobs & activity</strong>
            <Badge>{jobs.data?.length ?? 0}</Badge>
            <span className="grow" />
            {running && (
              <Button
                variant="ghost"
                disabled={busy || running.state !== "running"}
                onClick={() => {
                  void action(() => api.cancel(running.id));
                }}
              >
                <Square size={12} />
                {running.state === "cancellation_requested"
                  ? "Cancellation requested"
                  : "Request cancellation"}
              </Button>
            )}
            <Button
              variant="ghost"
              aria-label="Collapse jobs panel"
              onClick={() => ws.set({ console: false })}
            >
              <X size={14} />
            </Button>
          </div>
          <div className="console-body">
            <div className="job-list">
              {jobs.data?.length ? (
                jobs.data.map((j) => (
                  <button
                    key={j.id}
                    className={`job-row ${job?.id === j.id ? "selected" : ""}`}
                    onClick={() => ws.set({ job: j.id })}
                  >
                    <span
                      className={`status-dot ${j.state === "succeeded" ? "online" : j.state === "failed" ? "failed" : ""}`}
                    />
                    <div>
                      <strong>
                        {isNative
                          ? "Native inspection task"
                          : "Static application analysis"}
                      </strong>
                      <span>
                        {j.state} · {elapsed(j)}
                      </span>
                    </div>
                  </button>
                ))
              ) : (
                <div className="console-empty">
                  No analysis jobs yet.
                  <br />
                  Execution status and REA diagnostics appear here.
                </div>
              )}
            </div>
            <div className="log-output" aria-label="Execution logs">
              {logs.data?.length ? (
                [...logs.data].reverse().map((l, i) => (
                  <div key={`${l.at}:${i}`}>
                    <time>{new Date(l.at).toLocaleTimeString()}</time>
                    <span>{l.message}</span>
                  </div>
                ))
              ) : (
                <div className="log-placeholder">
                  <Terminal size={14} />
                  Waiting for an analysis job. No target has been executed.
                </div>
              )}
            </div>
          </div>
        </section>
      )}
      <footer className="statusbar">
        <span className={`status-dot ${isConnected ? "online" : ""}`} />
        <span>{status}</span>
        <span className="status-divider" />
        <span>Static investigation</span>
        <span className="grow" />
        {completedJob && (
          <span>
            {isNative
              ? `${completedJob.node_count} findings`
              : `${completedJob.node_count} entities · ${completedJob.edge_count} relationships`}
          </span>
        )}
        <span className="status-divider" />
        <span>No telemetry</span>
        <span className="status-divider" />
        <span>Studio 0.1.0</span>
      </footer>
      <Modal
        open={importOpen}
        onOpenChange={setImportOpen}
        title="New investigation"
        description="Organize a local target. Importing does not execute its code."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              const p = await api.import(projectName, importFormat);
              if (p) {
                await query.invalidateQueries({ queryKey: ["projects"] });
                ws.set({
                  project: p.id,
                  job: "",
                  selected: "",
                  view: "findings",
                });
                setImportOpen(false);
              }
            });
          }}
        >
          <label>
            Investigation name
            <input
              autoFocus
              required
              maxLength={120}
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="e.g. Desktop application architecture"
            />
          </label>
          <label>
            Target format
            <select
              value={importFormat}
              onChange={(e) => setImportFormat(e.target.value)}
            >
              <option value="directory">
                JavaScript application directory
              </option>
              <option value="asar">Electron ASAR archive</option>
              <option value="native">Native binary (ELF / PE / Mach-O)</option>
            </select>
          </label>
          <p className="muted">
            The native dialog will select your target. Original bytes stay in
            place; REA records their identity during analysis.
          </p>
          <div className="modal-actions">
            <Button type="button" onClick={() => setImportOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!desktopAvailable || busy || !projectName.trim()}
            >
              <FolderOpen size={15} />
              {busy ? "Opening native dialog…" : "Choose target & create"}
            </Button>
          </div>
        </form>
      </Modal>
      <Modal
        open={launchOpen}
        onOpenChange={setLaunchOpen}
        title={
          isNative ? "Inspect native binary" : "Run static application analysis"
        }
        description={
          isNative
            ? "Use existing REA static analysis tools. The selected binary is never executed."
            : "REA inventories the artifact, parses selected sources, and returns real application relationships."
        }
      >
        <div className="launch-summary">
          <span>Target</span>
          <code>{project?.target}</code>
          <span>Provider</span>
          <strong>
            {isNative
              ? "REA native analysis · configured providers"
              : "REA static JavaScript analysis · no native decompiler required"}
          </strong>
          <span>{isNative ? "Target execution" : "Integrity policy"}</span>
          <strong>
            {isNative
              ? "Disabled · static REA operations"
              : "Fail on integrity contradictions"}
          </strong>
        </div>
        {isNative && (
          <>
            <label>
              Native task
              <select
                value={nativeOperation}
                onChange={(e) =>
                  setNativeOperation(e.target.value as NativeOperation)
                }
              >
                {Object.entries(nativeNames).map(([operation, name]) => (
                  <option
                    key={operation}
                    value={operation}
                    disabled={
                      !connection.data?.native?.operations.find(
                        (o) => o.operation === operation,
                      )?.advertised
                    }
                  >
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Analysis provider
              <select
                value={nativeProvider}
                onChange={(e) => setNativeProvider(e.target.value)}
              >
                <option value="">
                  REA default (preserves configured preference)
                </option>
                <option value="auto">Automatic selection</option>
                {connection.data?.native?.providers.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.available}>
                    {p.name}
                    {p.available ? "" : " — unavailable"}
                  </option>
                ))}
              </select>
            </label>
            {[
              "function",
              "instructions",
              "references",
              "procedures",
              "instruction",
            ].includes(nativeOperation) && (
              <label>
                {nativeOperation === "procedures"
                  ? "Function name search (literal)"
                  : nativeOperation === "references" ||
                      nativeOperation === "instruction"
                    ? "Exact provider address"
                    : "Function name or provider address"}
                <input
                  value={nativeQuery}
                  maxLength={4096}
                  onChange={(e) => setNativeQuery(e.target.value)}
                  placeholder={
                    nativeOperation === "references" ||
                    nativeOperation === "instruction"
                      ? "0x10114c"
                      : "main"
                  }
                />
              </label>
            )}
            <p className="muted">
              Queries reuse the open REA session while the target and provider
              stay the same. Each task saves its original Evidence. Studio
              closes the session on exit, connection changes and task failure.
              Unavailable operations retain REA's diagnostic; Studio does not
              substitute a provider.
            </p>
          </>
        )}
        {!isNative && connection.data?.supports_source_paths && (
          <label>
            Exact source paths (optional, one per line)
            <textarea
              rows={4}
              value={sourcePaths}
              onChange={(e) => setSourcePaths(e.target.value)}
              placeholder={"package.json\nmain.js"}
            />
          </label>
        )}
        <p className="muted">
          {isNative
            ? "Native coverage and pseudocode limitations come from REA Evidence."
            : connection.data?.supports_source_paths
              ? "Leave empty to analyze the complete application. Selection reduces source parsing; unselected relationships remain unknown."
              : "This installation supports complete application analysis. Source selection is unavailable in its advertised contract."}{" "}
          No progress percentage is estimated.
        </p>
        <div className="modal-actions">
          <Button onClick={() => setLaunchOpen(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={
              !project ||
              !canRun ||
              busy ||
              !!running ||
              activeTask.data === true ||
              (isNative &&
                (!nativeOperationSupported ||
                  ([
                    "function",
                    "instructions",
                    "references",
                    "procedures",
                    "instruction",
                  ].includes(nativeOperation) &&
                    !nativeQuery.length)))
            }
            onClick={() => {
              void action(async () => {
                const id = await api.start(
                  project!.id,
                  (!isNative && connection.data?.supports_source_paths
                    ? sourcePaths
                    : ""
                  )
                    .split("\n")
                    .map((s) => (s.endsWith("\r") ? s.slice(0, -1) : s))
                    .filter((s) => s.length > 0),
                  isNative
                    ? {
                        operation: nativeOperation,
                        query: nativeQuery,
                        ...(nativeProvider
                          ? { provider_id: nativeProvider }
                          : {}),
                      }
                    : undefined,
                );
                ws.set({
                  job: id,
                  console: true,
                  ...(isNative
                    ? { selected: "", view: "findings" as const }
                    : {}),
                });
                setLaunchOpen(false);
                await query.invalidateQueries({ queryKey: ["jobs"] });
              });
            }}
          >
            <Play size={14} />
            Start analysis
          </Button>
        </div>
      </Modal>
      <Modal
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title="Rename investigation"
        description="Change the local project label."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              await api.rename(project!.id, projectName);
              await query.invalidateQueries({ queryKey: ["projects"] });
              setRenameOpen(false);
            });
          }}
        >
          <label>
            Name
            <input
              autoFocus
              maxLength={120}
              required
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
            />
          </label>
          <div className="modal-actions">
            <Button variant="primary" disabled={busy}>
              Save name
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function VirtualEntities({
  items,
  selected,
  select,
}: {
  items: Entity[];
  selected: string;
  select: (id: string) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 43,
    overscan: 12,
  });
  return (
    <>
      <div className="table-heading">
        <span>ENTITY</span>
        <span>TYPE</span>
        <span>PROVENANCE</span>
      </div>
      <div
        className="entity-table"
        ref={scroll}
        role="listbox"
        aria-label="Analysis findings"
        tabIndex={0}
        onKeyDown={(e) => {
          const index = items.findIndex((n) => n.id === selected);
          const next =
            e.key === "ArrowDown"
              ? Math.min(items.length - 1, index + 1)
              : e.key === "ArrowUp"
                ? Math.max(0, index - 1)
                : -1;
          if (next >= 0 && items[next]) {
            e.preventDefault();
            select(items[next]!.id);
            virtual.scrollToIndex(next);
          }
        }}
      >
        {!items.length ? (
          <Empty icon={<Search size={25} />} title="No matching entities">
            <p>Try another search or entity type.</p>
          </Empty>
        ) : (
          <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
            {virtual.getVirtualItems().map((row) => {
              const item = items[row.index]!;
              return (
                <button
                  key={item.id}
                  role="option"
                  aria-selected={selected === item.id}
                  className={`entity-row ${selected === item.id ? "selected" : ""}`}
                  onClick={() => select(item.id)}
                  style={{
                    height: row.size,
                    transform: `translateY(${row.start}px)`,
                  }}
                >
                  <span title={item.label}>
                    <FileCode2 size={15} />
                    {item.label}
                  </span>
                  <span>
                    <Badge>{item.kind}</Badge>
                  </span>
                  <span title={item.evidence_id}>
                    <ShieldCheck size={13} />
                    {item.evidence_id.slice(0, 14)}…
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
