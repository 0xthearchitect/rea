import { describe, expect, it } from "vitest";
import { normalizeBundle, supportedVersion } from "../bridge/normalize";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
function verificationDirectories() {
  try {
    return readdirSync(resolve(".local"), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
const paths = verificationDirectories()
  .filter((d) => d.isDirectory() && d.name.startsWith("verification-"))
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((d) => resolve(".local", d.name, "evidence.json"));
let bundle:
  | {
      records: {
        evidence_id: string;
        operation: string;
        normalized_result: { graph?: { edges: unknown[]; nodes: unknown[] } };
      }[];
    }
  | undefined;
for (const path of paths.reverse()) {
  try {
    const b = JSON.parse(readFileSync(path, "utf8"));
    if (
      b.records?.some(
        (r: { operation: string }) =>
          r.operation === "analyze_javascript_application",
      )
    ) {
      bundle = b;
      break;
    }
  } catch {
    /* Failed live runs may have no export. */
  }
}
describe("compatibility and malformed boundaries", () => {
  it("admits only the researched compatibility range", () => {
    expect(supportedVersion("6.4.0")).toBe(true);
    expect(supportedVersion("6.4.99")).toBe(true);
    for (const value of ["6.3.0", "7.0.0", "6.4.0-beta", "unknown", "6.4"])
      expect(supportedVersion(value)).toBe(false);
  });
  it("rejects malformed and absent Evidence without fabricating an ID", () => {
    for (const value of [null, {}, { records: [] }, { records: [{}] }])
      expect(() => normalizeBundle(value, `ev_${"0".repeat(64)}`)).toThrow();
  });
});
describe.skipIf(!bundle)(
  "normalization from a real self-owned analysis export",
  () => {
    const evidenceId =
      bundle?.records.find(
        (r) => r.operation === "analyze_javascript_application",
      )?.evidence_id ?? "";
    it("preserves upstream IDs and raw observation facts", () => {
      const p = normalizeBundle(bundle, evidenceId);
      const raw = bundle!.records.find((r) => r.evidence_id === evidenceId)!;
      expect(p.evidence_id).toBe(evidenceId);
      expect(p.nodes[0]?.facts).toEqual(raw.normalized_result.graph!.nodes[0]);
      expect(p.nodes.some((n) => n.label.includes("parser"))).toBe(true);
      expect(p.edges.some((e) => e.relation === "imports")).toBe(true);
    });
    it("rejects dangling edges and duplicate identities", () => {
      const bad = structuredClone(bundle!);
      const r = bad.records.find((v) => v.evidence_id === evidenceId)!;
      (
        r.normalized_result.graph!.edges[0] as { target_node_id: string }
      ).target_node_id = "absent";
      expect(() => normalizeBundle(bad, evidenceId)).toThrow("absent node");
      const duplicate = structuredClone(bundle!);
      const nodes = duplicate.records.find((v) => v.evidence_id === evidenceId)!
        .normalized_result.graph!.nodes;
      nodes.push(nodes[0]);
      expect(() => normalizeBundle(duplicate, evidenceId)).toThrow("Duplicate");
    });
  },
);
