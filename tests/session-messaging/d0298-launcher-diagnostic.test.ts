import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ensureSessionMessageBroker } from "../../mcp-server/src/session-message-client.js";

it("the actual launcher delivers a startup diagnostic from its broker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ags-d0298-launcher-"));
  const state = path.join(root, "state");
  try {
    let failure: unknown;
    try {
      await ensureSessionMessageBroker(state, 10000, undefined, async directory => {
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, "broker.lock"), "fixture", { flag: "wx" });
      });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("startup diagnostic: BROKER_LOCK_UNSUPPORTED_PATH");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);
