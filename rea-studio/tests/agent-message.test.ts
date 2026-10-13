import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AgentMessage from "../src/features/agents/AgentMessage";

describe("agent answer presentation", () => {
  it("formats headings, fenced code and tables while preserving Evidence text", () => {
    const html = renderToStaticMarkup(
      createElement(AgentMessage, {
        text: "## Function main\n\n```c\nreturn 0;\n```\n\n| Evidence | Coverage |\n| --- | --- |\n| ev_original_123 | unknown |",
      }),
    );
    expect(html).toContain("<h2>Function main</h2>");
    expect(html).toContain('class="agent-code-block"');
    expect(html).toContain("return 0;");
    expect(html).toContain("<table>");
    expect(html).toContain("ev_original_123");
    expect(html).toContain("unknown");
  });
  it("keeps target-controlled HTML, URLs and remote images inert", () => {
    const html = renderToStaticMarkup(
      createElement(AgentMessage, {
        text: '<script>alert(1)</script>\n\n[link](javascript:alert%281%29)\n\n![diagram](https://example.invalid/track.png)\n\n<iframe src="https://example.invalid"></iframe>',
      }),
    );
    expect(html).not.toMatch(/<(script|iframe|img|a)\b/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("diagram");
    expect(html).toContain("link");
  });
});
