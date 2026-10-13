import { useLayoutEffect, useRef, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Sparkles, X } from "lucide-react";
import type { AgentTurn } from "../../types/models";

export function AgentPanel({
  open,
  onClose,
  title,
  description,
  side = "right",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  side?: "left" | "right" | "center";
  children: ReactNode;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="agent-panel-overlay" />
        <Dialog.Content
          className={`agent-surface agent-panel agent-panel-${side}`}
        >
          <div className="agent-panel-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button className="agent-icon-button" aria-label="Close panel">
                <X size={17} />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="agent-panel-description">
            {description}
          </Dialog.Description>
          <div className="agent-panel-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function AgentSuggestions({
  native,
  choose,
}: {
  native: boolean;
  choose: (question: string) => void;
}) {
  const questions: [string, string][] = native
    ? [
        [
          "Explain main",
          "Explain the main function using static REA analysis. Cite original Evidence IDs and distinguish observations from unknowns.",
        ],
        [
          "Follow calls",
          "Inspect the calls and references observed for main. Cite original Evidence and preserve its limitations.",
        ],
        [
          "Review Evidence",
          "Review the selected facts and provenance. Explain what they support and what remains unknown.",
        ],
      ]
    : [
        [
          "Understand this app",
          "Analyze this application's structure with REA. Explain its main modules and cite original Evidence IDs.",
        ],
        [
          "Explore relationships",
          "Explain the observed module relationships using REA. Distinguish imports from calls and preserve unknown coverage.",
        ],
        [
          "Review Evidence",
          "Review the selected facts and provenance. Explain what they support and what remains unknown.",
        ],
      ];
  return (
    <div className="agent-suggestions">
      {questions.map(([title, question]) => (
        <button
          type="button"
          key={title}
          onPointerMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            e.currentTarget.style.setProperty(
              "--spot-x",
              `${e.clientX - rect.left}px`,
            );
            e.currentTarget.style.setProperty(
              "--spot-y",
              `${e.clientY - rect.top}px`,
            );
          }}
          onClick={() => choose(question)}
        >
          <Sparkles size={14} />
          {title}
        </button>
      ))}
    </div>
  );
}

export function AgentThinking({
  turn,
  starting = false,
}: {
  turn?: AgentTurn;
  starting?: boolean;
}) {
  // Activity is produced by the bridge; elapsed time never invents phases.
  const observations = turn?.activity.slice().reverse() ?? [];
  const latest = turn?.activity[0]?.message;
  const cancelling = turn?.state === "cancellation_requested";
  const title = cancelling
    ? "Cancellation requested…"
    : turn?.answer
      ? "Codex is responding…"
      : (latest ??
        (starting ? "Starting the connection…" : "Waiting for Codex…"));
  return (
    <div className="agent-thinking">
      <div className="agent-thinking-top">
        <div className="agent-orbit-loader" aria-hidden="true">
          <span />
          <span />
          <i />
        </div>
        <div>
          <div className="agent-thinking-kicker">
            Codex ·{" "}
            {cancelling
              ? "awaiting terminal status"
              : "investigation in progress"}
          </div>
          <div className="agent-shimmer" role="status">
            {title}
          </div>
        </div>
      </div>
      {!!observations.length && (
        <div className="agent-live-log">
          {observations.slice(-3).map((event, i) => (
            <div key={`${event.at}-${i}`}>
              <span className="agent-dot" />
              <span>{event.message}</span>
            </div>
          ))}
        </div>
      )}
      <div className="agent-thinking-note">
        Static REA workflows · original Evidence retained
      </div>
    </div>
  );
}

export function AgentThreadScroll({
  children,
  revision,
}: {
  children: ReactNode;
  revision: string;
}) {
  const element = useRef<HTMLDivElement>(null);
  // Follow only when the reader remains near the end; never jump on polling
  // while they read an older answer.
  const follow = useRef(true);
  useLayoutEffect(() => {
    if (follow.current && element.current)
      element.current.scrollTop = element.current.scrollHeight;
  }, [revision]);
  return (
    <div
      className="agent-thread-scroll"
      ref={element}
      onScroll={(e) => {
        const view = e.currentTarget;
        follow.current =
          view.scrollHeight - view.scrollTop - view.clientHeight < 100;
      }}
    >
      <div className="agent-thread-content">{children}</div>
    </div>
  );
}
