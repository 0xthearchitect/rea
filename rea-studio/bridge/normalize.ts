import { z } from "zod";
const jsonObject = z.record(z.unknown());
const fact = jsonObject.and(
  z.object({
    authority: z.string(),
    state: z.string(),
    coverage: z
      .object({
        status: z.enum(["complete", "partial", "unknown", "unavailable"]),
      })
      .passthrough(),
    limitations: z.array(z.string()),
  }),
);
const observation = z
  .object({
    observation_id: z.string().min(1),
    label: z.string().nullable(),
    properties: jsonObject,
    evidence: fact,
  })
  .passthrough();
const node = z
  .object({
    node_id: z.string().min(1),
    kind: z.string().min(1),
    identity: jsonObject,
    observations: z.array(observation).min(1),
  })
  .passthrough();
const edge = z
  .object({
    edge_id: z.string().min(1),
    source_node_id: z.string(),
    target_node_id: z.string(),
    relation: z.string(),
    evidence: fact,
  })
  .passthrough();
const record = z
  .object({
    evidence_id: z.string().regex(/^ev_[a-f0-9]{64}$/),
    operation: z.literal("analyze_javascript_application"),
    analysis_profile: jsonObject.nullable(),
    provider: jsonObject,
    parameters: jsonObject,
    subject: jsonObject.nullable(),
    confidence: z.enum(["observed", "derived", "inferred"]),
    authority: z.string(),
    raw_result: z.unknown(),
    limitations: z.array(z.string()),
    normalized_result: z
      .object({
        input_path: z.string(),
        root_artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/),
        graph: z
          .object({
            schema: z.literal("JavaScriptApplicationGraph"),
            nodes: z.array(node),
            edges: z.array(edge),
            coverage: z.object({ status: z.string() }).passthrough(),
            limitations: z.array(z.string()),
          })
          .passthrough(),
        limitations: z.array(z.string()),
      })
      .passthrough(),
  })
  .passthrough();
export function normalizeBundle(input: unknown, evidenceId: string) {
  const bundle = z.object({ records: z.array(z.unknown()) }).parse(input);
  const raw = bundle.records.find(
    (v) =>
      typeof v === "object" &&
      v !== null &&
      "evidence_id" in v &&
      v.evidence_id === evidenceId,
  );
  const evidence = record.parse(raw);
  const { normalized_result: result, ...header } = evidence;
  const ids = new Set<string>();
  const nodes = result.graph.nodes.map((n) => {
    if (ids.has(n.node_id)) throw new Error("Duplicate graph node identity");
    ids.add(n.node_id);
    const label =
      n.observations.find((o) => o.label !== null)?.label ??
      (typeof n.identity.path === "string" ? n.identity.path : n.node_id);
    return {
      id: n.node_id,
      label,
      kind: n.kind,
      evidence_id: evidence.evidence_id,
      facts: n,
    };
  });
  const edgeIds = new Set<string>();
  const edges = result.graph.edges.map((e) => {
    if (!ids.has(e.source_node_id) || !ids.has(e.target_node_id))
      throw new Error("Graph edge references an absent node");
    if (edgeIds.has(e.edge_id))
      throw new Error("Duplicate graph edge identity");
    edgeIds.add(e.edge_id);
    return {
      id: e.edge_id,
      source: e.source_node_id,
      target: e.target_node_id,
      relation: e.relation,
      evidence: e,
    };
  });
  return {
    evidence_id: evidence.evidence_id,
    header,
    nodes,
    edges,
    target_sha256: result.root_artifact_sha256,
    input_path: result.input_path,
    coverage: result.graph.coverage.status,
    limitations: [
      ...evidence.limitations,
      ...result.limitations,
      ...result.graph.limitations,
    ],
  };
}
export function supportedVersion(version: string) {
  return /^6\.4\.\d+$/.test(version);
}
