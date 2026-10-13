import { expect, it, onTestFinished, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { TsharkCaptureProvider } from "../../../src/captures/TsharkCaptureProvider.js";
import { PacketCaptureService } from "../../../src/application/captures/PacketCaptureService.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const cleanup = vi.hoisted(() => ({
  path: "",
  denied: false,
  handles: [] as FileHandle[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...filesystem,
    open: async (...args: Parameters<typeof filesystem.open>) => {
      const handle = await filesystem.open(...args);
      if (args[0] === cleanup.path) {
        cleanup.handles.push(handle);
        const close = handle.close.bind(handle);
        handle.close = async () => {
          if (cleanup.denied && handle.fd >= 0)
            throw new Error("Descriptor close deliberately denied");
          await close();
        };
      }
      return handle;
    },
  };
});

it
  .runIf(process.platform === "linux")
  .each([
    "capture",
    "tool",
    "limiter",
    "kernel",
    "field-tool",
    "field-limiter",
    "field-kernel",
  ])(
  "retains failed %s descriptors and retries them before further acquisition and shutdown",
  async (member) => {
    const directory = await createTestTempDirectory("rea-capture-descriptor-");
    const path = join(directory, "recording.pcap");
    const command = join(directory, "tshark.mjs");
    const limiter = join(directory, "limiter");
    await writeFile(path, "recording bytes");
    await writeFile(limiter, "limiter", { mode: 0o700 });
    await writeFile(
      command,
      `if(process.argv.includes('--version'))console.log('TShark (Wireshark) 4.0.17');else console.log('[{"_source":{"layers":{"frame.number":["1"]}}}]');`,
      { mode: 0o700 },
    );
    let launches = 0;
    const provider = new TsharkCaptureProvider(
      {
        ...process.env,
        REA_TSHARK_COMMAND: command,
        REA_TSHARK_PRLIMIT_COMMAND: limiter,
      },
      (input) => {
        launches += 1;
        return spawnOwnedProviderProcess({
          ...input,
          command: process.execPath,
          arguments: [command, ...input.arguments],
          expectedCommand: process.execPath,
        });
      },
      () => PrivateRuntimeRoot.create({ parent: directory }),
    );
    const discovery = member.startsWith("field-");
    const resource = discovery ? member.slice(6) : member;
    const operation = discovery
      ? "inspect_packet_fields"
      : "inspect_packet_capture";
    cleanup.path =
      resource === "capture"
        ? path
        : resource === "tool"
          ? command
          : resource === "limiter"
            ? limiter
            : "/proc/self/limits";
    cleanup.denied = true;
    cleanup.handles = [];
    onTestFinished(async () => {
      cleanup.denied = false;
      await provider.close();
      for (const handle of cleanup.handles) await handle.close();
      cleanup.path = "";
    });
    const service = new PacketCaptureService(provider);
    const first = discovery
      ? await service.inspectFields({ query: "usb" })
      : await service.inspect({ path, fields: ["frame.number"] });
    expect(first).toMatchObject({
      ok: false,
      error: {
        cleanupIncomplete: true,
        cleanupResources: [cleanup.path],
        operation,
      },
    });
    expect(cleanup.handles).toHaveLength(1);
    expect(cleanup.handles[0]?.fd).toBeGreaterThanOrEqual(0);
    const launchCount = launches;
    expect(
      await service.inspect({ path, fields: ["frame.number"] }),
    ).toMatchObject({
      ok: false,
      error: { cleanupIncomplete: true, operation },
    });
    expect(cleanup.handles).toHaveLength(1);
    expect(launches).toBe(launchCount);
    await expect(provider.close()).rejects.toMatchObject({
      cleanupIncomplete: true,
      operation,
    });
    cleanup.denied = false;
    await provider.close();
    expect(cleanup.handles[0]?.fd).toBe(-1);
  },
);
