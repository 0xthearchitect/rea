import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import {
  availability,
  nativeDiscovery,
  nativeRequest,
  normalizeNativeBundle,
  NativeSession,
} from "../bridge/native";

describe("native admission and boundaries", () => {
  it("retains session ownership until a valid close receipt", async () => {
    let receipt: unknown = {};
    const client = { callTool: async () => ({ structuredContent: receipt }) };
    const session = new NativeSession(
      client as unknown as ConstructorParameters<typeof NativeSession>[0],
    );
    session.openAttempted = true;
    await expect(session.close()).rejects.toThrow();
    expect(session.openAttempted).toBe(true);
    receipt = { result: null };
    await session.close();
    expect(session.openAttempted).toBe(false);
  });
  it("keeps unknown availability and accepts both observed inventories", () => {
    const individual = {
      result: {
        tool_availability: [
          {
            name: "binary_overview",
            available: false,
            reason: "target_required",
          },
          { name: "xrefs" },
        ],
      },
    };
    const compact = {
      result: {
        tool_availability: {
          groups: [
            {
              names: ["binary_overview"],
              available: false,
              reason: "target_required",
            },
            { names: ["xrefs"] },
          ],
        },
      },
    };
    expect(availability(individual)).toEqual(availability(compact));
    expect(availability(individual)[1]?.available).toBeNull();
    expect(
      nativeDiscovery({ result: {} }, [
        {
          name: "open_binary",
          inputSchema: { properties: { path: {}, provider_id: {} } },
        },
      ]).can_open,
    ).toBe(false);
  });
  it("allows only the named static operations and preserves query values", () => {
    const input = {
      operation: "references",
      provider_id: "ghidra",
      query: "EXTERNAL:0x1",
    };
    expect(nativeRequest.parse(input)).toEqual(input);
    for (const operation of [
      "annotate_native_function",
      "execute",
      "capture_native_ui_scenario",
    ])
      expect(() => nativeRequest.parse({ ...input, operation })).toThrow();
    expect(() => nativeRequest.parse({ ...input, query: "x\0y" })).toThrow();
    expect(() =>
      normalizeNativeBundle(
        { records: [] },
        [],
        {
          path: "/tmp/target",
          sha256: "0".repeat(64),
          format: "elf",
          architecture: null,
        },
        "overview",
      ),
    ).toThrow();
  });
  it("retains provider peers and reports malformed availability as unknown", () => {
    const session = {
      result: {
        analysis_provider_candidates: [
          {
            provider: { id: "ghidra", name: "Ghidra", version: "12.1.2" },
            availability: { status: "available", reason: null },
          },
          {
            provider: { id: "ida", name: "IDA", version: null },
            availability: { status: "unexpected" },
          },
        ],
      },
    };
    const providers = nativeDiscovery(session, []).providers;
    expect(providers).toHaveLength(2);
    expect(providers[0]?.available).toBe(true);
    expect(providers[1]?.available).toBeNull();
  });
});
const exportPath = process.env.STUDIO_NATIVE_TEST_BUNDLE;
describe.skipIf(!exportPath || !existsSync(exportPath))(
  "genuine retained native Evidence",
  () => {
    it("preserves per-record provenance and rejects identity drift", () => {
      const bundle = JSON.parse(readFileSync(exportPath!, "utf8"));
      const record = bundle.records.find(
        (r: { operation: string }) => r.operation === "analyze_function",
      );
      expect(record).toBeDefined();
      const opened = {
        path: record.subject.local_path,
        sha256: record.subject.digest.sha256,
        format: record.subject.format,
        architecture: record.subject.architecture,
      };
      const projection = normalizeNativeBundle(
        bundle,
        [record.evidence_id],
        opened,
        "function",
      );
      expect(projection.nodes[0]?.evidence_id).toBe(record.evidence_id);
      expect(projection.nodes[0]?.facts).toMatchObject({
        value: record.normalized_result,
      });
      expect(projection.nodes[0]?.kind).toBe("native-function");
      const view = (
        projection.nodes[0]?.facts as { view: { provider_selection: unknown } }
      ).view;
      expect(view.provider_selection).toEqual({});
      for (const choice of ["auto", "ghidra"]) {
        const selected = normalizeNativeBundle(
          bundle,
          [record.evidence_id],
          opened,
          "function",
          choice,
        );
        expect(
          (
            selected.nodes[0]?.facts as {
              view: { provider_selection: unknown };
            }
          ).view.provider_selection,
        ).toEqual({ provider_id: choice });
      }
      expect(projection.coverage).toBe("unknown");
      expect(() =>
        normalizeNativeBundle(
          bundle,
          [record.evidence_id],
          { ...opened, sha256: "0".repeat(64) },
          "function",
        ),
      ).toThrow("digest mismatch");
    });
  },
);
