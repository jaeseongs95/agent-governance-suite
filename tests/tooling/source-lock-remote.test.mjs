import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Run the public verifier in a fresh process: ROOT is captured at import time.
if (process.argv.includes("--source-lock-fixture")) {
  const { verifySourceLockRemote } = await import("../../scripts/source-lock.mjs");
  const errors = await verifySourceLockRemote();
  process.stdout.write(JSON.stringify(errors) + "\n");
  process.exitCode = errors.length === 0 ? 0 : 1;
} else {
  const { afterAll, beforeAll, describe, expect, test } = await import("vitest");
  const testFile = fileURLToPath(import.meta.url);
  const suppliedRoot = process.env.AGS_SOURCE_LOCK_FIXTURES;
  const environment = {
    ...process.env,
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  };
  let root;
  let fixture;

  function git(repository, args) {
    return execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8", env: environment, stdio: ["ignore", "pipe", "pipe"], timeout: 15_000,
    }).trim();
  }

  function checksum(content) {
    return "sha256:" + createHash("sha256").update("SKILL.md").update(content)
      .update("VERSION").update("1.0.0\n").digest("hex");
  }

  async function verify(id, changes = {}) {
    const directory = path.join(root, id);
    await mkdir(path.join(directory, "skills"), { recursive: true });
    const source = {
      skillId: "fixture", path: "skills/fixture", source: fixture.source,
      sourcePath: "skills/fixture", version: "1.0.0", versionSource: "version-file",
      ref: { kind: "commit", value: fixture.pin, commit: fixture.pin },
      updatePolicy: "notify-only", upstreamChecksum: fixture.pinChecksum,
      integratedChecksum: fixture.pinChecksum, downstreamModifications: [], ...changes,
    };
    await writeFile(path.join(directory, "skills", "source-lock.json"), JSON.stringify({ sources: [source] }) + "\n", "utf8");
    const tracePath = path.join(directory, "git.trace");
    await writeFile(tracePath, "", "utf8");
    const result = spawnSync(process.execPath, [testFile, "--source-lock-fixture"], {
      cwd: directory,
      env: { ...environment, AGENT_GOVERNANCE_ROOT: directory, GIT_TRACE: tracePath.split(path.sep).join("/") },
      encoding: "utf8", windowsHide: true, timeout: 20_000,
    });
    expect(result.error, "verifier process must execute").toBeUndefined();
    expect(result.signal).toBeNull();
    return { exitCode: result.status, errors: JSON.parse(result.stdout), trace: await readFile(tracePath, "utf8") };
  }

  describe("source lock remote verification", () => {
    beforeAll(async () => {
      root = suppliedRoot ? path.resolve(suppliedRoot) : await mkdtemp(path.join(tmpdir(), "ags-source-lock-tests-"));
      await mkdir(root, { recursive: true });
      const manifestPath = path.join(root, "fixture.json");
      try {
        fixture = JSON.parse(await readFile(manifestPath, "utf8"));
        return;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const origin = path.join(root, "origin");
      await mkdir(origin);
      git(origin, ["init", "--initial-branch=main"]);
      // Configuration stays inside this disposable fixture repository.
      git(origin, ["config", "user.name", "Source Lock Fixture"]);
      git(origin, ["config", "user.email", "fixture@example.invalid"]);
      git(origin, ["config", "commit.gpgsign", "false"]);
      git(origin, ["config", "tag.gpgsign", "false"]);
      git(origin, ["config", "core.autocrlf", "false"]);
      git(origin, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
      const skill = path.join(origin, "skills", "fixture");
      await mkdir(skill, { recursive: true });
      await writeFile(path.join(skill, "SKILL.md"), "# Base upstream\n", "utf8");
      await writeFile(path.join(skill, "VERSION"), "1.0.0\n", "utf8");
      git(origin, ["add", "skills"]);
      git(origin, ["commit", "-m", "base"]);
      const base = git(origin, ["rev-parse", "HEAD"]);
      git(origin, ["tag", "v1.0.0"]);
      await writeFile(path.join(skill, "SKILL.md"), "# Fixed upstream\n", "utf8");
      git(origin, ["add", "skills"]);
      git(origin, ["commit", "-m", "pin"]);
      const pin = git(origin, ["rev-parse", "HEAD"]);
      // Keep the object in origin but remove it from every advertised ref.
      git(origin, ["update-ref", "refs/heads/main", base, pin]);
      const source = pathToFileURL(origin).href;
      const probe = path.join(root, "clone-precondition");
      git(root, ["clone", "--quiet", "--no-checkout", source, probe]);
      expect(() => git(probe, ["rev-parse", "--verify", `${pin}^{commit}`]), "clone must omit the pinned object").toThrow();
      fixture = { source, base, pin, pinChecksum: checksum("# Fixed upstream\n"), baseChecksum: checksum("# Base upstream\n") };
      await writeFile(manifestPath, JSON.stringify(fixture, null, 2) + "\n", "utf8");
    });

    afterAll(async () => {
      if (!suppliedRoot && root) {
        const target = path.resolve(root);
        const parent = path.resolve(tmpdir());
        if (path.dirname(target) !== parent || !path.basename(target).startsWith("ags-source-lock-tests-")) throw new Error("fixture cleanup escaped owned temp directory");
        await rm(target, { recursive: true, force: true });
      }
    });

    test("recovers the exact commit omitted by clone with one fetch", async () => {
      const result = await verify("exact-pin");
      expect(result.errors, "exact commit recovery").toEqual([]);
      expect(result.exitCode).toBe(0);
      expect(result.trace.match(/built-in: git fetch --no-tags origin /gu)).toHaveLength(1);
      expect(result.trace).toContain(`fetch --no-tags origin ${fixture.pin}`);
    });

    test("rejects an unavailable pin without accepting the advertised latest commit", async () => {
      const missing = "0123456789012345678901234567890123456789";
      const result = await verify("missing-pin", { ref: { kind: "commit", value: missing, commit: missing } });
      expect(result.exitCode).toBe(1);
      expect(result.errors.join("\n")).toContain("cannot verify remote source fixture");
      expect(result.trace.match(/built-in: git fetch --no-tags origin /gu)).toHaveLength(1);
      expect(result.trace).toContain(`fetch --no-tags origin ${missing}`);
    });

    test("still checks the checksum after recovering the pin", async () => {
      const result = await verify("wrong-checksum", { upstreamChecksum: "sha256:" + "0".repeat(64) });
      expect(result.exitCode).toBe(1);
      expect(result.errors.join("\n"), "checksum guard after recovery").toContain("upstream checksum mismatch for fixture");
    });

    test("retains the tag version guard without a commit fetch", async () => {
      const result = await verify("wrong-tag-version", {
        ref: { kind: "tag", value: "v1.0.0", commit: fixture.base },
        version: "2.0.0", upstreamChecksum: fixture.baseChecksum,
      });
      expect(result.exitCode).toBe(1);
      expect(result.errors.join("\n")).toContain("remote tag/version mismatch for fixture");
      expect(result.trace).not.toContain("git fetch");
    });

    test("retains the sourcePath containment guard", async () => {
      const result = await verify("escaping-source-path", {
        ref: { kind: "commit", value: fixture.base, commit: fixture.base }, sourcePath: "..",
      });
      expect(result.exitCode).toBe(1);
      expect(result.errors.join("\n")).toContain("sourcePath escapes repository for fixture");
      expect(result.trace).not.toContain("git fetch");
    });
  });
}
