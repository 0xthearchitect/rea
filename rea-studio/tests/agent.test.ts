import { describe, it, expect } from "vitest";
import { agentInput, resultPage } from "../bridge/agent";
describe("agent boundaries", () => {
  it("preserves explicit questions/model choices and rejects unsupported workflows", () => {
    const input = {
      action: "agent",
      agent: "/tmp/trusted-codex",
      model: "caller-model",
      question: "Explain ‘offline search’",
      target: "/tmp/selected",
      workflow: "native",
      directory: "/tmp/owned-turn",
      history: [],
      context: null,
    };
    expect(agentInput.parse(input)).toEqual(input);
    expect(() => agentInput.parse({ ...input, question: "x\0y" })).toThrow();
    expect(() => agentInput.parse({ ...input, workflow: "execute" })).toThrow();
    expect(() => agentInput.parse({ ...input, agent: "codex" })).toThrow();
  });
  it("pages original findings without inventing Evidence or coverage", () => {
    const node = {
      id: "local-id",
      label: "main",
      kind: "native-function",
      evidence_id: "original",
      facts: { value: { confidence: null }, view: {} },
    };
    const projection = {
      evidence_id: "original",
      header: { authority: "shipped-artifact" },
      coverage: "unknown",
      limitations: ["provider limitation"],
      nodes: [node, { ...node, id: "second" }],
    };
    const page = resultPage(projection, 0, 1);
    expect(page.items).toEqual([node]);
    expect(page.next_offset).toBe(1);
    expect(page.coverage).toBe("unknown");
    expect(page.record).toEqual(projection.header);
    const end = resultPage(projection, 1, 1);
    expect(end.next_offset).toBeNull();
    expect(end.total_findings).toBe(2);
  });
});
