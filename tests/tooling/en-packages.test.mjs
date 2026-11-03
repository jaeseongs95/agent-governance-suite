import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CODEX_EN_NAME, CODEX_MANIFEST, EN_LOCALE, LOCALE_FILE, PACKAGES, checkEnPackage, renderEnPackage } from "../../scripts/build-en-packages.mjs";

const root = path.resolve(import.meta.dirname, "..", "..");
const json = async (...parts) => JSON.parse(await readFile(path.join(root, ...parts), "utf8"));

describe("English-only packages", () => {
  it.each(Object.keys(PACKAGES))("%s differs from its source only in the package locale", async (name) => {
    const files = await renderEnPackage(name, root);
    expect(files.get(LOCALE_FILE)).toEqual(EN_LOCALE);
    const source = name === "claude-plugin-en" ? (file) => path.join(root, "claude-plugin", file)
      : (file) => path.join(root, file === "README.md" ? "README.en.md" : file);
    for (const [file, content] of files) {
      if (file === LOCALE_FILE || (name === "codex-plugin-en" && file === CODEX_MANIFEST)) continue;
      expect(content.equals(await readFile(source(file))), file).toBe(true);
    }
  });

  it("names each manifest the way its host requires, and ships what each host reads", async () => {
    const claude = await renderEnPackage("claude-plugin-en", root);
    const codex = await renderEnPackage("codex-plugin-en", root);
    // Claude keeps the manifest name (skill prefix); Codex requires it to equal the entry name.
    expect(JSON.parse(claude.get(".claude-plugin/plugin.json")).name).toBe("agent-governance-suite");
    const manifest = JSON.parse(codex.get(CODEX_MANIFEST));
    const source = JSON.parse(await readFile(path.join(root, CODEX_MANIFEST), "utf8"));
    expect([manifest.id, manifest.name]).toEqual([CODEX_EN_NAME, CODEX_EN_NAME]);
    expect({ ...manifest, id: source.id, name: source.name, interface: source.interface }).toEqual(source);
    expect(JSON.stringify(manifest.interface)).not.toMatch(/[가-힣]/u);
    for (const file of [".mcp.json", "hooks/hooks.json", "mcp-server/dist/server.mjs", "mcp-server/dist/continuity-hook.mjs",
      "skills/registry.json", "runtime/engineering-practices/CONTENT_LOCK.json", "claude-overlay/adaptations/code-review.json"]) {
      expect(codex.has(file), file).toBe(true);
    }
    expect([...codex.keys()].some((file) => file.startsWith("tests/") || file.startsWith("claude-plugin/"))).toBe(false);
  });

  it("lists the English entries next to the Korean ones in both marketplaces", async () => {
    const release = await json("release", "version.json");
    const codex = await json(".agents", "plugins", "marketplace.json");
    const entry = codex.plugins.find((plugin) => plugin.name === "agent-governance-suite-en");
    expect(entry.source).toEqual({ source: "git-subdir", url: codex.plugins[0].source.url, path: "codex-plugin-en", ref: `v${release.version}` });
    expect(entry.policy).toEqual(codex.plugins[0].policy);
    expect(entry.name).toBe(CODEX_EN_NAME);
  });

  it("reports a stale committed package", async () => {
    // A throwaway repository with one tracked claude-plugin file is enough for the comparison.
    const repo = await mkdtemp(path.join(os.tmpdir(), "ags-en-"));
    try {
      const run = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
      run("init", "-q");
      await mkdir(path.join(repo, "claude-plugin", "runtime"), { recursive: true });
      await mkdir(path.join(repo, "claude-plugin-en", "runtime"), { recursive: true });
      await writeFile(path.join(repo, "claude-plugin", "runtime", "locale.json"), "{\n  \"locale\": \"ko\"\n}\n");
      await writeFile(path.join(repo, "claude-plugin", "README.md"), "a\n");
      run("add", "claude-plugin");
      await writeFile(path.join(repo, "claude-plugin-en", "runtime", "locale.json"), EN_LOCALE);
      await writeFile(path.join(repo, "claude-plugin-en", "README.md"), "a\n");
      expect(await checkEnPackage("claude-plugin-en", repo)).toEqual([]);
      await writeFile(path.join(repo, "claude-plugin-en", "README.md"), "b\n");
      await writeFile(path.join(repo, "claude-plugin-en", "extra.txt"), "x\n");
      expect((await checkEnPackage("claude-plugin-en", repo)).sort()).toEqual([
        "stale file claude-plugin-en/README.md", "unexpected file claude-plugin-en/extra.txt"]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
