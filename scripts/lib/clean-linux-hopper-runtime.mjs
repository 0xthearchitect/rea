import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Observe leftover demo processes on a dedicated clean Linux runner, including
 * groups reparented after their launcher exits. This is not ownership proof and
 * never authorizes signaling; unrelated runtime processes also block this lane.
 */
export const assertCleanLinuxHopperRuntime = async () => {
  const { stdout } = await execFileAsync("ps", ["-ax", "-o", "command="]);
  if (/\/opt\/hopper\/bin\/Hopper|\bXvfb\b|hopper-demo-x11\.py/u.test(stdout))
    throw new Error("Clean Linux runner retained a Hopper demo process");
};
