import { memo, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="agent-code-block">
      <div className="agent-code-caption">
        <span>Code</span>
        <button
          type="button"
          onClick={() => {
            setError("");
            void (async () => {
              try {
                await navigator.clipboard.writeText(
                  code.current?.textContent ?? "",
                );
                setCopied(true);
              } catch {
                setError("Select the code to copy it.");
              }
            })();
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre ref={code}>{children}</pre>
      {error && (
        <span className="agent-copy-error" role="status">
          {error}
        </span>
      )}
    </div>
  );
}

// Markdown is presentation of the original answer, not a new Evidence record.
// Raw HTML stays escaped; model-provided links/images remain readable text.
const components = {
  pre: CodeBlock,
  a: ({ children, href }: { children?: ReactNode; href?: string }) => (
    <span className="agent-text-link" title={href}>
      {children}
    </span>
  ),
  img: ({ alt, src }: { alt?: string; src?: string }) => (
    <span className="agent-image-description">
      [Image: {alt || src || "unspecified"}]
    </span>
  ),
};
export default memo(function AgentMessage({ text }: { text: string }) {
  return (
    <div className="agent-markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  );
});
