import { z } from "zod";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

export const nativeTasks = {
  overview: "binary_overview",
  procedures: "search_procedures",
  strings: "list_strings",
  function: "analyze_function",
  instructions: "read_function_instructions",
  references: "xrefs",
  instruction: "inspect_native_instruction",
} as const;
export const nativeRequest = z
  .object({
    operation: z.enum([
      "overview",
      "procedures",
      "strings",
      "function",
      "instructions",
      "references",
      "instruction",
    ]),
    provider_id: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .optional(),
    query: z
      .string()
      .max(4096)
      .refine((s) => !s.includes("\0")),
  })
  .strict();

type Inventory = {
  name: string;
  available: boolean | null;
  reason: string | null;
  remediation: string | null;
};
// Own both observed upstream inventories. Unknown values stay unknown.
export function availability(session: unknown): Inventory[] {
  const outer = z
    .object({
      result: z.object({ tool_availability: z.unknown() }).passthrough(),
    })
    .safeParse(session);
  if (!outer.success) return [];
  const raw = outer.data.result.tool_availability;
  const entries = Array.isArray(raw)
    ? raw
    : raw &&
        typeof raw === "object" &&
        "groups" in raw &&
        Array.isArray(raw.groups)
      ? raw.groups
      : [];
  return entries.flatMap((entry: unknown) => {
    const parsed = z
      .object({
        name: z.string().optional(),
        names: z.array(z.string()).optional(),
        available: z.boolean().optional(),
        reason: z.string().nullable().optional(),
        remediation: z.string().nullable().optional(),
      })
      .passthrough()
      .safeParse(entry);
    if (!parsed.success) return [];
    const p = parsed.data;
    return (p.name !== undefined ? [p.name] : (p.names ?? [])).map((name) => ({
      name,
      available: p.available ?? null,
      reason: p.reason ?? null,
      remediation: p.remediation ?? null,
    }));
  });
}
export function nativeDiscovery(
  session: unknown,
  tools: { name: string; inputSchema: unknown }[],
) {
  const has = (name: string, fields: string[] = []) => {
    const schema = z
      .object({ properties: z.record(z.unknown()) })
      .safeParse(tools.find((t) => t.name === name)?.inputSchema);
    return (
      schema.success && fields.every((field) => field in schema.data.properties)
    );
  };
  const inventory = availability(session);
  const entry = inventory.find((i) => i.name === "open_binary");
  const candidates = z
    .object({
      result: z
        .object({
          analysis_provider_candidates: z.array(z.unknown()).optional(),
        })
        .passthrough(),
    })
    .safeParse(session);
  return {
    can_open:
      has("open_binary", ["path", "provider_id"]) &&
      has("binary_session") &&
      has("close_binary") &&
      has("export_evidence_bundle", ["path", "overwrite"]) &&
      entry?.available === true,
    providers: candidates.success
      ? (candidates.data.result.analysis_provider_candidates ?? []).flatMap(
          (raw) => {
            const candidate = z
              .object({
                provider: z.object({
                  id: z.string(),
                  name: z.string(),
                  version: z.string().nullable().optional(),
                }),
                availability: z.unknown(),
              })
              .passthrough()
              .safeParse(raw);
            if (!candidate.success) return [];
            const status = z
              .object({
                status: z.enum(["available", "unavailable"]),
                reason: z.string().nullable(),
              })
              .passthrough()
              .safeParse(candidate.data.availability);
            return [
              {
                id: candidate.data.provider.id,
                name: candidate.data.provider.name,
                version: candidate.data.provider.version ?? null,
                available: status.success
                  ? status.data.status === "available"
                  : null,
                reason: status.success
                  ? status.data.reason
                  : "Provider availability is unknown; inspect original session status",
              },
            ];
          },
        )
      : [],
    operations: Object.entries(nativeTasks).map(([operation, name]) => {
      const status = inventory.find((i) => i.name === name);
      const fields =
        operation === "procedures"
          ? ["pattern", "mode", "case_sensitive"]
          : operation === "function" || operation === "instructions"
            ? ["procedure"]
            : operation === "references" || operation === "instruction"
              ? ["address"]
              : [];
      return {
        operation,
        name,
        advertised: has(name, fields),
        available: status?.available ?? null,
        reason: status?.reason ?? "availability unknown",
      };
    }),
  };
}

const jsonObject = z.record(z.unknown());
const nativeRecord = z
  .object({
    evidence_id: z.string().regex(/^ev_[a-f0-9]{64}$/),
    operation: z.enum(Object.values(nativeTasks) as [string, ...string[]]),
    subject: z
      .object({
        local_path: z.string(),
        digest: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
      })
      .passthrough(),
    provider: jsonObject,
    analysis_profile: jsonObject.nullable(),
    parameters: jsonObject,
    raw_result: z.unknown(),
    normalized_result: z.unknown(),
    confidence: z.enum(["observed", "derived", "inferred"]),
    authority: z.string(),
    limitations: z.array(z.string()),
  })
  .passthrough();
const namedAddress = z
  .object({
    address: z.string(),
    value: z.string(),
    string: jsonObject.optional(),
  })
  .passthrough();
const procedure = z
  .object({ address: z.string(), name: z.string() })
  .passthrough();
const segment = z
  .object({
    name: z.string(),
    start: z.string(),
    end: z.string(),
    length: z.number(),
  })
  .passthrough();
type View = {
  title: string;
  fields: { label: string; value: unknown }[];
  procedure?: string;
  code?: string;
  assembly?: string[];
  actions?: {
    label: string;
    operation: keyof typeof nativeTasks;
    query: string;
  }[];
  tables?: {
    title: string;
    columns: string[];
    rows: unknown[][];
    links?: { operation: keyof typeof nativeTasks; query: string }[];
  }[];
};
const field = (label: string, value: unknown) => ({
  label,
  value: value ?? null,
});

/** REA owns the observations; this adapter owns their single display projection. */
export function normalizeNativeBundle(
  input: unknown,
  ids: string[],
  opened: {
    path: string;
    sha256: string;
    format: string;
    architecture: string | null;
  },
  task: string,
  providerSelection?: string,
) {
  const bundle = z.object({ records: z.array(z.unknown()) }).parse(input);
  if (!ids.length || new Set(ids).size !== ids.length)
    throw new Error(
      "Native analysis requires distinct retained Evidence references",
    );
  const records = ids.map((id) =>
    nativeRecord.parse(
      bundle.records.find(
        (record) =>
          record !== null &&
          typeof record === "object" &&
          "evidence_id" in record &&
          record.evidence_id === id,
      ),
    ),
  );
  for (const record of records) {
    if (record.subject.digest.sha256 !== opened.sha256)
      throw new Error("Native Evidence target digest mismatch");
    if (record.subject.local_path !== opened.path)
      throw new Error("Native Evidence target path mismatch");
  }
  const nodes: {
    id: string;
    label: string;
    kind: string;
    evidence_id: string;
    facts: unknown;
  }[] = [];
  const headers = records.map(
    ({ raw_result: _raw, normalized_result: _normalized, ...header }) => ({
      evidence_id: header.evidence_id,
      header,
    }),
  );
  const add = (
    record: (typeof records)[number],
    kind: string,
    label: string,
    value: unknown,
    view: View,
  ) => {
    nodes.push({
      id: `${record.evidence_id}:${nodes.length}`,
      label,
      kind,
      evidence_id: record.evidence_id,
      facts: {
        studio_format: "native-v1",
        value,
        view: {
          ...view,
          provider_selection: {
            ...(providerSelection !== undefined
              ? { provider_id: providerSelection }
              : {}),
          },
        },
      },
    });
  };
  for (const record of records) {
    const result = record.normalized_result;
    if (record.operation === "binary_overview") {
      const r = z
        .object({ document: z.string(), segments: z.array(segment) })
        .passthrough()
        .parse(result);
      add(record, "native-overview", "Binary overview", result, {
        title: "Binary overview",
        fields: [
          field("Format", opened.format),
          field("Architecture", opened.architecture),
          field("SHA-256", opened.sha256),
          field("Document", r.document),
        ],
      });
      for (const s of r.segments)
        add(record, "native-segment", s.name, s, {
          title: s.name,
          fields: [
            field("Start", s.start),
            field("End", s.end),
            field("Length (bytes)", s.length),
          ],
        });
    } else if (
      record.operation === "search_procedures" ||
      record.operation === "list_strings"
    ) {
      const rows = z.array(namedAddress).parse(result);
      for (const row of rows)
        add(
          record,
          record.operation === "search_procedures"
            ? "native-procedure"
            : "native-string",
          row.value,
          row,
          {
            title: row.value,
            ...(record.operation === "search_procedures"
              ? { procedure: row.address }
              : {}),
            fields: [
              field("Address", row.address),
              ...(row.string
                ? [
                    field("Encoding", row.string.encoding),
                    field("Byte length", row.string.byte_length),
                    field("Termination", row.string.termination),
                  ]
                : []),
            ],
            actions: [
              {
                label: "References",
                operation: "references",
                query: row.address,
              },
            ],
          },
        );
      if (!rows.length)
        add(record, "native-result", record.operation, result, {
          title: record.operation,
          fields: [field("Returned entries", 0)],
        });
    } else if (record.operation === "analyze_function") {
      const r = z
        .object({
          procedure,
          pseudocode: z.string(),
          assembly: z.array(z.string()),
          callers: z.array(procedure),
          callees: z.array(procedure),
        })
        .passthrough()
        .parse(result);
      add(record, "native-function", r.procedure.name, result, {
        title: r.procedure.name,
        procedure: r.procedure.address,
        actions: [
          {
            label: "Instructions",
            operation: "instructions",
            query: r.procedure.address,
          },
          {
            label: "References",
            operation: "references",
            query: r.procedure.address,
          },
        ],
        code: r.pseudocode,
        assembly: r.assembly,
        fields: [
          field("Address", r.procedure.address),
          field("Signature", r.procedure.signature),
          field("Relationship coverage", r.relationship_coverage),
          field("Pseudocode", "Decompiler-generated; not original source"),
        ],
        tables: [
          {
            title: "REA callers",
            columns: ["Address", "Name"],
            rows: r.callers.map((p) => [p.address, p.name]),
            links: r.callers.map((p) => ({
              operation: "function",
              query: p.address,
            })),
          },
          {
            title: "REA callees",
            columns: ["Address", "Name"],
            rows: r.callees.map((p) => [p.address, p.name]),
            links: r.callees.map((p) => ({
              operation: "function",
              query: p.address,
            })),
          },
        ],
      });
    } else if (record.operation === "read_function_instructions") {
      const r = z
        .object({ procedure, instructions: z.array(z.string()) })
        .passthrough()
        .parse(result);
      add(record, "native-instructions", r.procedure.name, result, {
        title: r.procedure.name,
        procedure: r.procedure.address,
        actions: [
          {
            label: "References",
            operation: "references",
            query: r.procedure.address,
          },
        ],
        assembly: r.instructions,
        fields: [field("Address", r.procedure.address)],
      });
    } else if (record.operation === "xrefs") {
      const rows = z.array(z.string()).parse(result);
      add(
        record,
        "native-references",
        "References to selected address",
        result,
        {
          title: "References to selected address",
          fields: [field("Address", record.parameters.address)],
          tables: [
            {
              title: "REA reference sources",
              columns: ["Address"],
              rows: rows.map((address) => [address]),
              links: rows.map((address) => ({
                operation: "instruction",
                query: address,
              })),
            },
          ],
        },
      );
    } else if (record.operation === "inspect_native_instruction") {
      const r = z
        .object({
          address: z.string(),
          status: z.string(),
          procedure: z.string().nullable(),
          architecture: z.string(),
          mode: z.string(),
          raw_disassembly: z.string().nullable(),
          bytes: z.string().nullable(),
          references: z.array(
            z
              .object({ target_address: z.string(), type: z.string() })
              .passthrough(),
          ),
          limitations: z.array(z.string()),
        })
        .passthrough()
        .parse(result);
      add(record, "native-instruction", r.address, result, {
        title: `Address ${r.address}`,
        ...(r.procedure !== null ? { procedure: r.procedure } : {}),
        fields: [
          field("Address", r.address),
          field("Status", r.status),
          field("Procedure", r.procedure),
          field("Architecture", r.architecture),
          field("Mode", r.mode),
          field("Bytes", r.bytes),
          field("Limitations", r.limitations),
        ],
        ...(r.raw_disassembly !== null
          ? { assembly: [r.raw_disassembly] }
          : {}),
        actions: [
          { label: "References", operation: "references", query: r.address },
        ],
        tables: [
          {
            title: "REA reference targets",
            columns: ["Address", "Type"],
            rows: r.references.map((p) => [p.target_address, p.type]),
            links: r.references.map((p) => ({
              operation: "instruction",
              query: p.target_address,
            })),
          },
        ],
      });
    }
  }
  const primary = records[0];
  if (!primary || !headers[0])
    throw new Error("Native Evidence selection is empty");
  return {
    evidence_id: primary.evidence_id,
    header: headers[0].header,
    records: headers,
    nodes,
    edges: [],
    target_sha256: opened.sha256,
    input_path: opened.path,
    coverage: "unknown",
    limitations: records.flatMap((r) => r.limitations),
    workflow: "native",
    task,
  };
}

export class NativeSession {
  identity?: {
    path: string;
    sha256: string;
    format: string;
    architecture: string | null;
  };
  target?: string;
  provider?: string;
  openAttempted = false;
  tasks = 0;
  constructor(readonly client: Client) {}
  async close() {
    if (!this.openAttempted) return;
    const closed = await this.client.callTool(
      { name: "close_binary", arguments: {} },
      undefined,
      { timeout: 120000 },
    );
    if (closed.isError)
      throw new Error(
        `Native cleanup failed or remains unknown: ${JSON.stringify(closed.content)}`,
      );
    z.object({ result: z.null() }).parse(closed.structuredContent);
    // Keep ownership until REA confirms closure.
    this.identity = undefined;
    this.target = undefined;
    this.provider = undefined;
    this.tasks = 0;
    this.openAttempted = false;
  }
}
async function digest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function analyzeNative(
  client: Client,
  request: Record<string, unknown>,
  signal: AbortSignal,
  emit: (type: string, value: unknown) => void,
  version: string,
  discovery: ReturnType<typeof nativeDiscovery>,
  retained = new NativeSession(client),
) {
  const task = nativeRequest.parse(request.native_request);
  const target = z.string().refine(isAbsolute).parse(request.target);
  const output = z.string().refine(isAbsolute).parse(request.output);
  const projection = z.string().refine(isAbsolute).parse(request.projection);
  if (!discovery.can_open)
    throw new Error(
      "The live installation does not advertise the required native lifecycle contracts",
    );
  if (
    !discovery.operations.find((o) => o.operation === task.operation)
      ?.advertised
  )
    throw new Error(
      "The requested native operation is not in the live contract",
    );
  if (
    [
      "function",
      "instructions",
      "references",
      "procedures",
      "instruction",
    ].includes(task.operation) &&
    !task.query.length
  )
    throw new Error(
      "The selected operation requires a function, address, or search text",
    );
  const call = async (name: string, args: Record<string, unknown>) => {
    signal.throwIfAborted();
    emit("progress", `REA ${version}: ${name}`);
    const reply = await client.callTool({ name, arguments: args }, undefined, {
      timeout: 30 * 60 * 1000,
      signal,
      resetTimeoutOnProgress: true,
      onprogress: (p) =>
        emit("progress", p.message ?? `Progress observation ${p.progress}`),
    });
    if (reply.isError) throw new Error(JSON.stringify(reply.content));
    return reply.structuredContent;
  };
  const ids: string[] = [];
  let exported = false;
  let failure: unknown;
  const exportOriginal = async () => {
    await call("export_evidence_bundle", { path: output, overwrite: false });
    exported = true;
  };
  try {
    const targetPath = await realpath(target);
    const sha256 = await digest(target);
    const reused =
      retained.identity !== undefined &&
      retained.target === target &&
      retained.identity.path === targetPath &&
      retained.identity.sha256 === sha256 &&
      retained.provider === task.provider_id;
    if (!reused) {
      await retained.close();
      retained.openAttempted = true;
      const identity = z
        .object({
          result: z
            .object({
              path: z.string(),
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
              format: z.string(),
              architecture: z.string().nullable(),
            })
            .passthrough(),
        })
        .parse(
          await call("open_binary", {
            path: target,
            ...(task.provider_id ? { provider_id: task.provider_id } : {}),
          }),
        ).result;
      if ((await realpath(identity.path)) !== (await realpath(target)))
        throw new Error("REA opened another native target");
      if (identity.sha256 !== sha256)
        throw new Error("Native target changed while opening");
      retained.identity = identity;
      retained.target = target;
      retained.provider = task.provider_id;
    } else
      emit(
        "progress",
        "Reusing the open REA session after checking target bytes and provider selection.",
      );
    const identity = retained.identity!;
    const session = await call("binary_session", {});
    const current = availability(session);
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const state = current.find((s) => s.name === name);
      if (state?.available !== true)
        throw new Error(
          `${name}: ${state?.reason ?? "availability unknown"}. ${state?.remediation ?? "Inspect the configured REA provider."}`,
        );
      const record = nativeRecord.parse(await call(name, args));
      if (!ids.includes(record.evidence_id)) ids.push(record.evidence_id);
    };
    if (task.operation === "overview") await invoke("binary_overview", {});
    else if (task.operation === "procedures")
      await invoke("search_procedures", {
        pattern: task.query,
        mode: "literal",
        case_sensitive: false,
      });
    else if (task.operation === "strings") await invoke("list_strings", {});
    else if (
      task.operation === "references" ||
      task.operation === "instruction"
    )
      await invoke(nativeTasks[task.operation], { address: task.query });
    else await invoke(nativeTasks[task.operation], { procedure: task.query });
    await exportOriginal();
    if ((await digest(target)) !== identity.sha256)
      throw new Error(
        "Native target bytes changed during analysis; reopen the target",
      );
    if ((await stat(output)).size > 64 * 1024 * 1024)
      throw new Error(
        "Complete Evidence saved, but exceeds the 64 MiB indexing bound; original remains on disk",
      );
    const normalized = normalizeNativeBundle(
      JSON.parse(await readFile(output, "utf8")),
      ids,
      identity,
      task.operation,
      task.provider_id,
    );
    signal.throwIfAborted();
    await writeFile(projection, JSON.stringify(normalized), {
      flag: "wx",
      mode: 0o600,
    });
    retained.tasks++;
    // export_evidence_bundle has no selector: rotate before cumulative retention
    // grows indefinitely. Every completed task keeps its complete original export.
    if (
      retained.tasks >= 128 ||
      (await stat(output)).size >= 32 * 1024 * 1024
    ) {
      emit(
        "progress",
        "Rotating the native session at the retained Evidence resource bound.",
      );
      await retained.close();
    }
    return {
      version,
      evidence_id: normalized.evidence_id,
      projection,
      raw_path: output,
      session_reused: reused,
    };
  } catch (error) {
    failure = error;
    if (ids.length && !exported && !signal.aborted) {
      try {
        await exportOriginal();
      } catch (exportError) {
        emit(
          "progress",
          `Failed to retain original Evidence: ${String(exportError)}`,
        );
      }
    }
    throw error;
  } finally {
    if (
      retained.openAttempted &&
      (failure !== undefined || request.keep_alive !== true)
    ) {
      emit(
        "progress",
        "Closing the native REA session; cleanup must be reported by REA.",
      );
      try {
        await retained.close();
      } catch (cleanupError) {
        throw new Error(
          `${failure instanceof Error ? failure.message + "; " : ""}Native cleanup failed or remains unknown: ${String(cleanupError)}`,
        );
      }
    }
  }
}
