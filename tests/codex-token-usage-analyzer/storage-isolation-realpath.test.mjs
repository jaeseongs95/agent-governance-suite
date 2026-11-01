import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { validateMarkdownDirectory } from "../../skills/codex-token-usage-analyzer/scripts/core.mjs";

// AGS 3.0 error model P2 (D-0223): a realpath failure other than absence must not degrade the isolation check.
const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "token-isolation-"));
  directories.push(directory);
  const pluginRoot = path.join(directory, "plugin");
  await mkdir(pluginRoot);
  return { directory, pluginRoot };
}

it.skipIf(process.platform === "win32")("rejects when the sessions root cannot be resolved (ELOOP)", async () => {
  const { directory, pluginRoot } = await fixture();
  const sessionsRoot = path.join(directory, "loop-a");
  await symlink(path.join(directory, "loop-b"), sessionsRoot);
  await symlink(sessionsRoot, path.join(directory, "loop-b"));
  await expect(validateMarkdownDirectory(path.join(directory, "out"), { sessionsRoot, pluginRoot }))
    .rejects.toMatchObject({ code: "ELOOP" });
});

it("still accepts a destination when the sessions root does not exist (ENOENT)", async () => {
  const { directory, pluginRoot } = await fixture();
  const destination = path.join(directory, "out");
  await expect(validateMarkdownDirectory(destination, { sessionsRoot: path.join(directory, "absent"), pluginRoot }))
    .resolves.toBe(destination);
});

it.skipIf(process.platform === "win32")("still rejects a destination that reaches the sessions root through a link", async () => {
  const { directory, pluginRoot } = await fixture();
  const sessionsRoot = path.join(directory, "sessions");
  await mkdir(sessionsRoot);
  await symlink(sessionsRoot, path.join(directory, "alias"));
  await expect(validateMarkdownDirectory(path.join(directory, "alias", "out"), { sessionsRoot, pluginRoot })).rejects.toThrow();
});
