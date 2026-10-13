import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  Code2,
  Folder,
  FolderOpen,
  History,
  LockKeyhole,
  PanelRight,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  X,
} from "lucide-react";
import { api, desktopAvailable, message } from "../../integrations/desktop";
import { Failure, Loading } from "../../components/ui";
import type {
  Project,
  Connection,
  AgentSettings,
  Json,
  AgentTurn,
} from "../../types/models";
import AgentMessage from "./AgentMessage";
import {
  AgentPanel,
  AgentSuggestions,
  AgentThinking,
  AgentThreadScroll,
} from "./AgentSurface";
import "./agents.css";

const active = (state: string) =>
  state === "running" || state === "cancellation_requested";
function usage(value: Json) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "Token usage unavailable";
  const total = value.total;
  if (!total || typeof total !== "object" || Array.isArray(total))
    return "Token usage unavailable";
  const count = (name: string) =>
    typeof total[name] === "number" ? String(total[name]) : "Unknown";
  return `Input ${count("inputTokens")} · cached ${count("cachedInputTokens")} · output ${count("outputTokens")}`;
}
type Panel = "history" | "projects" | "context" | "settings" | "preview" | null;
type ContextTab = "selection" | "evidence" | "activity";

export default function AgentView({
  project,
  projects,
  selectProject,
  jobId,
  entityId,
  selectionLabel,
  providerId,
  setProvider,
  connection,
  busyAnalysis,
  openEvidence,
  openInvestigation,
  importProject,
}: {
  project?: Project;
  projects: Project[];
  selectProject: (id: string) => void;
  jobId: string;
  entityId: string;
  selectionLabel: string;
  providerId: string;
  setProvider: (id: string) => void;
  connection?: Connection;
  busyAnalysis: boolean;
  openEvidence: (id: string) => void;
  openInvestigation: () => void;
  importProject: () => void;
}) {
  const cache = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [question, setQuestion] = useState("");
  const [attach, setAttach] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingTurn, setPendingTurn] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [tab, setTab] = useState<ContextTab>("selection");
  const [search, setSearch] = useState("");
  const [inspectedTurn, setInspectedTurn] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [settings, setSettings] = useState<AgentSettings>({
    executable: "",
    model: "",
  });
  const settingsQuery = useQuery({
    queryKey: ["agent-settings"],
    queryFn: api.agentSettings,
    enabled: desktopAvailable,
  });
  useEffect(() => {
    if (settingsQuery.data) setSettings(settingsQuery.data);
  }, [settingsQuery.data]);
  const agent = useQuery({
    queryKey: ["agent-connection"],
    queryFn: api.detectAgent,
    enabled: false,
    retry: false,
  });
  const conversations = useQuery({
    queryKey: ["agent-conversations", project?.id],
    queryFn: () => api.conversations(project!.id),
    enabled: desktopAvailable && !!project,
  });
  const conversation = selected ?? conversations.data?.[0]?.id ?? "";
  const turns = useQuery({
    queryKey: ["agent-turns", conversation, offset],
    queryFn: () => api.agentTurns(conversation, offset),
    enabled: desktopAvailable && !!conversation,
    refetchInterval: 1000,
  });
  // Latest state owns admission/cancellation even while browsing an older page.
  const latest = useQuery({
    queryKey: ["agent-turns", conversation, 0],
    queryFn: () => api.agentTurns(conversation, 0),
    enabled: desktopAvailable && !!conversation && offset !== 0,
    refetchInterval: offset !== 0 ? 1000 : false,
  });
  const latestData = offset === 0 ? turns.data : latest.data;
  const running = latestData?.items.find((turn) => active(turn.state));
  useEffect(() => {
    if (
      pendingTurn &&
      latestData?.items.some((turn) => turn.id === pendingTurn)
    )
      setPendingTurn(null);
  }, [pendingTurn, latestData]);
  useEffect(() => {
    setInspectedTurn(null);
  }, [conversation, offset]);
  const starting = !!pendingTurn;
  const locked = busy || !!running || starting || busyAnalysis;
  const context = useQuery({
    queryKey: [
      "agent-context",
      project?.id,
      attach ? jobId : "",
      attach ? entityId : "",
    ],
    queryFn: () =>
      api.agentContext(
        project!.id,
        attach ? jobId : "",
        attach ? entityId : "",
      ),
    enabled: desktopAvailable && !!project,
    retry: false,
  });
  useEffect(() => {
    if (!desktopAvailable) return;
    const subscriptions = [
      listen<{ conversation_id: string }>("studio:agent-event", (event) => {
        if (event.payload.conversation_id === conversation)
          void cache.invalidateQueries({
            queryKey: ["agent-turns", conversation],
          });
      }),
      listen("studio:agent-finished", () => {
        void cache.invalidateQueries({ queryKey: ["agent-turns"] });
        void cache.invalidateQueries({ queryKey: ["jobs"] });
        void cache.invalidateQueries({ queryKey: ["active-task"] });
      }),
    ];
    return () => {
      for (const subscription of subscriptions)
        void subscription.then((unlisten) => unlisten());
    };
  }, [cache, conversation]);
  useEffect(() => {
    if (input.current) {
      input.current.style.height = "auto";
      input.current.style.height = `${Math.min(170, Math.max(86, input.current.scrollHeight))}px`;
    }
  }, [question]);
  async function act(work: () => Promise<unknown>) {
    setError("");
    setBusy(true);
    try {
      await work();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  function newConversation() {
    if (locked) return;
    setSelected("");
    setOffset(0);
    setQuestion("");
    setPanel(null);
    setError("");
    requestAnimationFrame(() => input.current?.focus());
  }
  const canSend =
    desktopAvailable &&
    !!project &&
    !!settings.executable &&
    !!question.trim() &&
    !locked &&
    !!context.data &&
    !context.error &&
    offset === 0 &&
    (!conversation || !turns.isPending);
  async function send() {
    if (!canSend) return;
    await act(async () => {
      await api.saveAgentSettings(settings);
      const id = conversation || (await api.newConversation(project!.id));
      // Retain a newly created conversation if startup fails, and preserve the draft.
      setSelected(id);
      setOffset(0);
      const turn = await api.startAgent(
        id,
        question,
        attach ? jobId : "",
        attach ? entityId : "",
        providerId || undefined,
      );
      setPendingTurn(turn);
      setQuestion("");
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["agent-conversations"] }),
        cache.invalidateQueries({ queryKey: ["agent-turns"] }),
        cache.invalidateQueries({ queryKey: ["active-task"] }),
      ]);
    });
  }
  const pageTurns = turns.data?.items.slice().reverse() ?? [];
  const hasThread = !!pageTurns.length || starting;
  const evidenceTurns = latestData?.items ?? [];
  const last = inspectedTurn
    ? [...pageTurns, ...evidenceTurns].find((turn) => turn.id === inspectedTurn)
    : evidenceTurns[0];
  const referenceCount = evidenceTurns.reduce(
    (count, turn) => count + turn.evidence.length,
    0,
  );
  const revision = `${conversation}:${offset}:${pageTurns.map((turn) => `${turn.id}:${turn.state}:${turn.answer.length}`).join(",")}:${pendingTurn}`;
  const title =
    panel === "projects"
      ? "Choose an investigation"
      : panel === "history"
        ? "Your conversations"
        : panel === "settings"
          ? "Connect your Codex"
          : panel === "preview"
            ? "Review context before sending"
            : "Investigation context";
  const description =
    panel === "projects"
      ? "Conversations and original Evidence belong to the selected project."
      : panel === "history"
        ? "Conversations saved in this investigation."
        : panel === "settings"
          ? "Uses your installed client's authentication and configured model provider."
          : panel === "preview"
            ? "Your question, completed history and selected facts go to the model provider configured in Codex. REA analysis stays local."
            : "The project owns the target. You choose the attached facts and the REA analysis provider.";

  function turnReferences(turn: AgentTurn) {
    return turn.evidence.map((reference, i) => (
      <button
        type="button"
        className="agent-reference"
        key={reference.job_id}
        title={reference.evidence_id}
        onClick={() => openEvidence(reference.job_id)}
      >
        <ShieldCheck size={13} />
        <span className="agent-reference-number">
          {String(i + 1).padStart(2, "0")}
        </span>
        <span>Original REA Evidence</span>
        <ArrowRight size={13} />
        <span className="agent-reference-id">{reference.evidence_id}</span>
      </button>
    ));
  }

  return (
    <div className={`agent-canvas ${hasThread ? "has-thread" : ""}`}>
      <div className="agent-workspace-bar">
        <div className="agent-project-nav">
          <button
            type="button"
            className="agent-icon-button"
            title="Back to investigations"
            aria-label="Investigations"
            onClick={openInvestigation}
          >
            <ArrowLeft size={17} />
          </button>
          <Folder size={14} />
          <button
            type="button"
            className="agent-project-trigger"
            aria-label="Agent investigation"
            disabled={!desktopAvailable || locked}
            onClick={() => setPanel("projects")}
          >
            <span>{project?.name ?? "Select investigation"}</span>
            <ChevronDown size={12} />
          </button>
        </div>
        <div className="agent-workspace-tools">
          <button
            type="button"
            className="agent-toolbar-button"
            onClick={() => setPanel("history")}
            disabled={!project || !desktopAvailable}
          >
            <History size={15} />
            <span>History</span>
          </button>
          <button
            type="button"
            className="agent-icon-button"
            aria-label="New conversation"
            title="New conversation"
            onClick={newConversation}
            disabled={!project || locked || !desktopAvailable}
          >
            <Plus size={17} />
          </button>
          <button
            type="button"
            className="agent-icon-button"
            aria-label="Codex settings"
            title="Codex settings"
            onClick={() => setPanel("settings")}
            disabled={!desktopAvailable}
          >
            <Settings2 size={17} />
          </button>
          <button
            type="button"
            className="agent-context-trigger"
            onClick={() => setPanel("context")}
            disabled={!project || !desktopAvailable}
          >
            <PanelRight size={13} />
            Context<span>{attach ? 2 : 1}</span>
            <ChevronDown size={12} />
          </button>
        </div>
      </div>
      {(error ||
        settingsQuery.error ||
        context.error ||
        conversations.error ||
        turns.error ||
        latest.error) && (
        <div className="agent-feedback">
          <Failure
            text={
              error ||
              message(
                settingsQuery.error ||
                  context.error ||
                  conversations.error ||
                  turns.error ||
                  latest.error,
              )
            }
          />
          <button
            className="agent-icon-button"
            aria-label="Dismiss agent error"
            onClick={() => setError("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      <div className="agent-canvas-body">
        {hasThread ? (
          <AgentThreadScroll
            key={`${conversation}:${offset}`}
            revision={revision}
          >
            {pageTurns.map((turn) => (
              <article className="agent-turn" key={turn.id}>
                <div className="agent-user-row">
                  <div className="agent-user-bubble">
                    <div>
                      <span>You</span>
                      <time>
                        {new Date(turn.created_at).toLocaleTimeString(
                          undefined,
                          { hour: "2-digit", minute: "2-digit" },
                        )}
                      </time>
                    </div>
                    <p>{turn.question}</p>
                  </div>
                </div>
                <div className="agent-response">
                  <div className="agent-response-heading">
                    <span className="agent-avatar">
                      <Sparkles size={15} />
                    </span>
                    <strong>Codex</strong>
                    <span className="agent-inference">Analyst inference</span>
                    <span
                      className={`agent-turn-status ${turn.state}`}
                      title={turn.model ?? "Model not reported"}
                    >
                      {turn.state === "completed" && <Check size={11} />}{" "}
                      {turn.state.replaceAll("_", " ")}
                    </span>
                  </div>
                  <div className="agent-response-body">
                    {turn.answer && <AgentMessage text={turn.answer} />}
                    {active(turn.state) ? (
                      <AgentThinking turn={turn} />
                    ) : (
                      !turn.answer && (
                        <p className="agent-muted">No answer was returned.</p>
                      )
                    )}
                    {turn.message && <Failure text={turn.message} />}
                    <div className="agent-references">
                      {turnReferences(turn)}
                    </div>
                    <button
                      type="button"
                      className="agent-turn-details"
                      onClick={() => {
                        setInspectedTurn(turn.id);
                        setPanel("context");
                        setTab("activity");
                      }}
                    >
                      {turn.model ?? "Model unavailable"} · {usage(turn.usage)}
                      {turn.finished_at
                        ? ` · ${((turn.finished_at - turn.created_at) / 1000).toFixed(1)} s`
                        : ""}
                    </button>
                    <details className="agent-sent-context">
                      <summary>Context sent with this question</summary>
                      <pre>{JSON.stringify(turn.context, null, 2)}</pre>
                    </details>
                  </div>
                </div>
              </article>
            ))}
            {starting && <AgentThinking starting />}
            {turns.data && turns.data.total > 5 && (
              <div className="agent-pagination">
                <button
                  type="button"
                  disabled={offset === 0 || locked}
                  onClick={() => setOffset(Math.max(0, offset - 5))}
                >
                  Newer messages
                </button>
                <span>
                  {offset + 1}–{Math.min(offset + 5, turns.data.total)} of{" "}
                  {turns.data.total}
                </span>
                <button
                  type="button"
                  disabled={turns.data.next_offset === null || locked}
                  onClick={() => setOffset(turns.data!.next_offset!)}
                >
                  Older messages
                </button>
              </div>
            )}
          </AgentThreadScroll>
        ) : (
          <div className="agent-hero">
            <div className="agent-hero-orb" aria-hidden="true">
              <span />
              <i>
                <Sparkles size={30} />
              </i>
            </div>
            <div className="agent-hero-kicker">
              <span className="agent-dot" />
              Your investigation partner
            </div>
            <h1>
              Ask the question.
              <br />
              <span>Follow the Evidence.</span>
            </h1>
            <p>
              Explore code with Codex and REA.
              <br />
              Every investigation starts with a good question.
            </p>
          </div>
        )}
        <div className="agent-prompt-unit">
          <form
            className={`agent-prompt ${running || starting ? "is-running" : ""}`}
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            {attach && (
              <div className="agent-attachments">
                <span>
                  <Code2 size={12} />
                  {entityId ? selectionLabel : "Analysis metadata"}
                  <button
                    type="button"
                    aria-label="Remove attached context"
                    disabled={locked}
                    onClick={() => setAttach(false)}
                  >
                    <X size={12} />
                  </button>
                </span>
              </div>
            )}
            <textarea
              ref={input}
              aria-label="Your question"
              rows={2}
              maxLength={32768}
              value={question}
              disabled={!desktopAvailable || !project || locked}
              placeholder={
                !project
                  ? "Choose an investigation to begin…"
                  : "What do you want to discover in this target?"
              }
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <div className="agent-prompt-tools">
              <button
                type="button"
                className="agent-attach-trigger"
                aria-label="Attach selected context"
                title={
                  attach ? "Remove selected context" : "Attach selected context"
                }
                disabled={!jobId || !project || locked}
                onClick={() => {
                  setAttach(!attach);
                }}
              >
                <Plus size={17} />
              </button>
              <button
                type="button"
                className="agent-model-trigger"
                onClick={() => setPanel("settings")}
                disabled={!desktopAvailable}
              >
                <Sparkles size={14} />
                <span>Codex</span>
                <small>{settings.model || "Default"}</small>
                <ChevronDown size={11} />
              </button>
              <span className="agent-static-mode">
                <ShieldCheck size={12} />
                Static analysis
              </span>
              {running ? (
                <button
                  type="button"
                  className="agent-send is-cancelling"
                  aria-label="Cancel turn"
                  disabled={running.state === "cancellation_requested" || busy}
                  onClick={() => void act(() => api.cancelAgent(running.id))}
                >
                  <span>
                    {running.state === "cancellation_requested"
                      ? "Requested"
                      : "Stop"}
                  </span>
                  <Square size={12} />
                </button>
              ) : (
                <button
                  className="agent-send"
                  type="submit"
                  aria-label="Send question"
                  disabled={!canSend}
                >
                  <ArrowUp size={18} />
                </button>
              )}
            </div>
          </form>
          <div className="agent-prompt-meta">
            <span>Enter to send · Shift + Enter for a new line</span>
            <button
              type="button"
              onClick={() => setPanel("preview")}
              disabled={!project || !desktopAvailable}
            >
              <LockKeyhole size={10} />
              Review context
            </button>
          </div>
          {!desktopAvailable ? (
            <div className="agent-availability">
              <Terminal size={16} />
              <div>
                <h2>Desktop required for agents</h2>
                <p>Open the desktop app to use Codex and local REA Evidence.</p>
              </div>
            </div>
          ) : !project ? (
            <div className="agent-availability">
              <FolderOpen size={17} />
              <div>
                <h2>Select an investigation</h2>
                <button type="button" onClick={importProject}>
                  New investigation <ArrowRight size={12} />
                </button>
              </div>
            </div>
          ) : !settings.executable ? (
            <div className="agent-availability">
              <Sparkles size={16} />
              <div>
                <h2>Connect your installed Codex</h2>
                <button type="button" onClick={() => setPanel("settings")}>
                  Configure connection <ArrowRight size={12} />
                </button>
              </div>
            </div>
          ) : busyAnalysis && !running && !starting ? (
            <p className="agent-admission-note">
              Another REA or agent task is active. Finish it before sending.
            </p>
          ) : offset !== 0 ? (
            <button
              type="button"
              className="agent-admission-note"
              onClick={() => setOffset(0)}
            >
              Return to the latest messages to send a question.
            </button>
          ) : null}
        </div>
        {!hasThread && project && desktopAvailable && (
          <AgentSuggestions
            native={project.workflow === "native"}
            choose={(text) => {
              setQuestion(text);
              input.current?.focus();
            }}
          />
        )}
        {!hasThread && (
          <p className="agent-privacy">
            <ShieldCheck size={10} />
            REA runs locally. Context goes to your configured Codex model
            provider.
          </p>
        )}
      </div>
      <AgentPanel
        open={panel !== null}
        onClose={() => setPanel(null)}
        title={title}
        description={description}
        side={
          panel === "history" || panel === "projects"
            ? "left"
            : panel === "settings" || panel === "preview"
              ? "center"
              : "right"
        }
      >
        {panel === "projects" ? (
          <>
            {projects.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`agent-history-entry ${project?.id === item.id ? "selected" : ""}`}
                disabled={locked}
                onClick={() => {
                  setPanel(null);
                  selectProject(item.id);
                }}
              >
                <span>{item.name}</span>
                <small>{item.target}</small>
              </button>
            ))}
            <button
              type="button"
              className="agent-panel-button"
              disabled={locked}
              onClick={() => {
                setPanel(null);
                importProject();
              }}
            >
              <Plus size={14} />
              New investigation
            </button>
          </>
        ) : panel === "settings" ? (
          <div className="agent-settings-form">
            <label>
              Trusted Codex executable
              <input
                value={settings.executable}
                disabled={locked}
                onChange={(event) =>
                  setSettings({ ...settings, executable: event.target.value })
                }
              />
            </label>
            <button
              className="agent-panel-button"
              disabled={locked}
              onClick={() =>
                void act(async () => {
                  const picked = await api.pickAgent();
                  if (picked) {
                    setSettings(picked);
                    await cache.invalidateQueries({
                      queryKey: ["agent-settings"],
                    });
                  }
                })
              }
            >
              <FolderOpen size={14} />
              Browse
            </button>
            <label>
              Model
              <input
                value={settings.model}
                disabled={locked}
                placeholder="Use Codex's configured default"
                onChange={(event) =>
                  setSettings({ ...settings, model: event.target.value })
                }
              />
            </label>
            <p className="agent-muted">
              Leave the model empty to preserve the client default. Sign in
              through Codex; Studio does not collect API keys.
            </p>
            <div className="agent-panel-actions">
              <button
                className="agent-panel-button"
                disabled={locked || !settings.executable}
                onClick={() =>
                  void act(async () => {
                    await api.saveAgentSettings(settings);
                    const checked = await agent.refetch();
                    if (checked.error) throw checked.error;
                  })
                }
              >
                Check connection
              </button>
              <button
                className="agent-panel-button primary"
                disabled={locked}
                onClick={() =>
                  void act(async () => {
                    await api.saveAgentSettings(settings);
                    await cache.invalidateQueries({
                      queryKey: ["agent-settings"],
                    });
                    setPanel(null);
                  })
                }
              >
                Save settings
              </button>
            </div>
            {agent.isFetching && <Loading label="Checking Codex transport…" />}
            {agent.data && <p className="agent-muted">{agent.data.message}</p>}
            {agent.error && <Failure text={message(agent.error)} />}{" "}
            {error && <Failure text={error} />}
          </div>
        ) : panel === "history" ? (
          <>
            <div className="agent-history-search">
              <Search size={14} />
              <input
                aria-label="Search conversations"
                placeholder="Find by number or date…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            {conversations.isPending && <Loading />}
            {conversations.data
              ?.map((item, i) => ({
                item,
                label: `Conversation ${conversations.data.length - i}`,
                date: new Date(item.created_at).toLocaleString(),
              }))
              .filter(({ label, date }) =>
                `${label} ${date}`.toLowerCase().includes(search.toLowerCase()),
              )
              .map(({ item, label, date }) => (
                <button
                  type="button"
                  className={`agent-history-entry ${conversation === item.id ? "selected" : ""}`}
                  key={item.id}
                  disabled={locked}
                  onClick={() => {
                    setSelected(item.id);
                    setOffset(0);
                    setPanel(null);
                  }}
                >
                  <span>{label}</span>
                  <small>{date}</small>
                </button>
              ))}
            {!conversations.data?.length && (
              <p className="agent-muted">
                Your first conversation starts when you send a question.
              </p>
            )}
            <button
              className="agent-panel-button"
              disabled={locked}
              onClick={newConversation}
            >
              <Plus size={14} />
              New conversation
            </button>
          </>
        ) : panel === "preview" ? (
          <>
            <div className="agent-target-card">
              <Folder size={18} />
              <div>
                <strong>{project?.name}</strong>
                <small>{project?.target}</small>
              </div>
            </div>
            <p className="agent-muted">
              Attached:{" "}
              {attach
                ? entityId
                  ? selectionLabel
                  : "analysis metadata"
                : "project target only"}
              . Completed conversation text is also included by Studio.
            </p>
            {context.isPending ? (
              <Loading />
            ) : (
              <pre className="agent-context-json">
                {JSON.stringify(context.data, null, 2)}
              </pre>
            )}
          </>
        ) : panel === "context" ? (
          <>
            <div
              className="agent-context-tabs"
              role="tablist"
              aria-label="Agent context views"
            >
              <i
                style={{
                  transform: `translateX(${tab === "selection" ? 0 : tab === "evidence" ? 100 : 200}%)`,
                }}
              />
              {(["selection", "evidence", "activity"] as const).map(
                (value, i, all) => (
                  <button
                    type="button"
                    role="tab"
                    id={`agent-tab-${value}`}
                    aria-controls={`agent-context-${value}`}
                    aria-selected={tab === value}
                    tabIndex={tab === value ? 0 : -1}
                    key={value}
                    onClick={() => setTab(value)}
                    onKeyDown={(event) => {
                      const index =
                        event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? 2
                            : event.key === "ArrowRight"
                              ? (i + 1) % 3
                              : event.key === "ArrowLeft"
                                ? (i + 2) % 3
                                : null;
                      const next = index === null ? undefined : all[index];
                      if (next) {
                        event.preventDefault();
                        setTab(next);
                        document.getElementById(`agent-tab-${next}`)?.focus();
                      }
                    }}
                  >
                    {value === "evidence"
                      ? `Evidence ${referenceCount || ""}`
                      : value.charAt(0).toUpperCase() + value.slice(1)}
                  </button>
                ),
              )}
            </div>
            <div
              role="tabpanel"
              id={`agent-context-${tab}`}
              aria-labelledby={`agent-tab-${tab}`}
              className="agent-tab-content"
            >
              {tab === "selection" ? (
                <>
                  <div className="agent-section-label">Project target</div>
                  <div className="agent-target-card">
                    <Folder size={19} />
                    <div>
                      <strong>{project?.target.split(/[\\/]/).pop()}</strong>
                      <small>{project?.target}</small>
                    </div>
                    <span>Fixed</span>
                  </div>
                  <div className="agent-section-label">Selected context</div>
                  <div className="agent-context-card">
                    <div>
                      <Code2 size={14} />
                      <strong>
                        {entityId ? selectionLabel : "Analysis metadata"}
                      </strong>
                      <input
                        type="checkbox"
                        aria-label="Attach selected finding"
                        checked={attach}
                        disabled={!jobId || locked}
                        onChange={(event) => setAttach(event.target.checked)}
                      />
                    </div>
                    <p>
                      {!jobId
                        ? "Run a REA analysis to make findings available for attachment."
                        : attach
                          ? "Selected facts and original provenance are included with the next question."
                          : "Available to attach. Currently excluded from the next question."}
                    </p>
                  </div>
                  {project?.workflow === "native" && (
                    <>
                      <div className="agent-section-label">
                        REA analysis provider
                      </div>
                      <select
                        aria-label="REA analysis provider"
                        value={providerId}
                        disabled={locked}
                        onChange={(event) => setProvider(event.target.value)}
                      >
                        <option value="">REA default</option>
                        <option value="auto">Automatic selection</option>
                        {connection?.native?.providers.map((item) => (
                          <option
                            key={item.id}
                            value={item.id}
                            disabled={!item.available}
                          >
                            {item.name}
                            {item.available ? "" : " — unavailable"}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                  <button
                    className="agent-panel-button"
                    onClick={() => setPanel("preview")}
                  >
                    <LockKeyhole size={13} />
                    Review context before sending
                  </button>
                </>
              ) : tab === "evidence" ? (
                <>
                  {evidenceTurns.map((turn) => (
                    <div className="agent-panel-references" key={turn.id}>
                      {turnReferences(turn)}
                    </div>
                  ))}
                  {!referenceCount && (
                    <p className="agent-muted">
                      Original Evidence appears here when the agent requests a
                      REA analysis. Links for older questions remain on their
                      history pages.
                    </p>
                  )}
                </>
              ) : (
                <>
                  {last ? (
                    <>
                      <span className="agent-section-label">
                        {inspectedTurn
                          ? "Selected question"
                          : "Latest question"}{" "}
                        · {last.state.replaceAll("_", " ")}
                      </span>
                      {last.activity
                        .slice()
                        .reverse()
                        .map((event, i) => (
                          <div
                            className="agent-activity-observation"
                            key={`${event.at}-${i}`}
                          >
                            <span className="agent-dot" />
                            <div>
                              <p>{event.message}</p>
                              <time>
                                {new Date(event.at).toLocaleTimeString()}
                              </time>
                            </div>
                          </div>
                        ))}
                      {!last.activity.length && (
                        <p className="agent-muted">No activity reported yet.</p>
                      )}
                      <p className="agent-muted">{usage(last.usage)}</p>
                    </>
                  ) : (
                    <p className="agent-muted">
                      Activity will appear when you send a question.
                    </p>
                  )}
                </>
              )}
            </div>
          </>
        ) : null}
      </AgentPanel>
    </div>
  );
}
