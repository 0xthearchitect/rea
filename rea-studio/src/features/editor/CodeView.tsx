import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { useWorkspace } from "../../stores/workspace";
import { Loading } from "../../components/ui";
loader.config({ monaco });
self.MonacoEnvironment = { getWorker: () => new editorWorker() };
export default function CodeView({
  value,
  language = "javascript",
}: {
  value: string;
  language?: string;
}) {
  const theme = useWorkspace((s) => s.theme);
  return (
    <Editor
      height="100%"
      theme={theme === "dark" ? "vs-dark" : "vs"}
      language={language}
      value={value}
      loading={<Loading label="Opening local editor…" />}
      options={{
        readOnly: true,
        domReadOnly: true,
        automaticLayout: true,
        fontFamily: "Cascadia Code, Consolas, monospace",
        fontSize: 12,
        lineHeight: 20,
        minimap: { enabled: false },
        padding: { top: 18 },
        scrollBeyondLastLine: false,
        wordWrap: "off",
        renderLineHighlight: "line",
        unicodeHighlight: { ambiguousCharacters: true },
        links: false,
      }}
    />
  );
}
