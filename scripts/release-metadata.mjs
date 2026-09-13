import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ROOT, readJson } from "./lib.mjs";

const SEMVER = /^\d+\.\d+\.\d+$/u;

export function replaceExactlyOnce(text, pattern, replacement, label) {
  const matches = [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))];
  if (matches.length !== 1) {
    throw new Error(`${label} marker/value must occur exactly once; found ${matches.length}`);
  }
  return text.replace(pattern, replacement);
}

export function assertMarkerPair(text, name, label) {
  for (const edge of ["start", "end"]) {
    const marker = `<!-- ${name}:${edge} -->`;
    const count = text.split(marker).length - 1;
    if (count !== 1) throw new Error(`${label} ${marker} must occur exactly once; found ${count}`);
  }
}

async function updateJson(relativePath, mutate) {
  const target = path.join(ROOT, relativePath);
  const current = await readJson(target);
  mutate(current);
  return { target, content: `${JSON.stringify(current, null, 2)}\n` };
}

async function updateText(relativePath, mutate) {
  const target = path.join(ROOT, relativePath);
  const current = await readFile(target, "utf8");
  return { target, content: mutate(current) };
}

export async function expectedReleaseFiles() {
  const release = await readJson(path.join(ROOT, "release", "version.json"));
  if (!SEMVER.test(release.version ?? "")) {
    throw new Error("release/version.json must contain a strict semantic version");
  }
  const version = release.version;
  return [
    await updateJson("package.json", (document) => { document.version = version; }),
    await updateJson(".codex-plugin/plugin.json", (document) => { document.version = version; }),
    await updateJson(".agents/plugins/marketplace.json", (document) => {
      const entries = document.plugins?.filter((entry) => entry.name === "agent-governance-suite") ?? [];
      if (entries.length !== 1) throw new Error("marketplace plugin entry must occur exactly once");
      entries[0].source.ref = `v${version}`;
    }),
    await updateText("mcp-server/src/plugin-info.ts", (text) => replaceExactlyOnce(
      text,
      /version: "\d+\.\d+\.\d+"/u,
      `version: "${version}"`,
      "MCP plugin version",
    )),
    await updateText("README.md", (text) => {
      assertMarkerPair(text, "release-version", "README.md");
      assertMarkerPair(text, "release-install", "README.md");
      return replaceExactlyOnce(replaceExactlyOnce(text,
        /(<!-- release-version:start -->\r?\n[\s\S]*?현재 공개 릴리스는 `v)\d+\.\d+\.\d+(`[^\r\n]*\r?\n<!-- release-version:end -->)/u,
        `$1${version}$2`,
        "README.md release-version",
      ),
        /(<!-- release-install:start -->\r?\n[\s\S]*?--ref v)\d+\.\d+\.\d+([\s\S]*?\r?\n<!-- release-install:end -->)/u,
        `$1${version}$2`,
        "README.md release-install",
      );
    }),
    await updateText("README.en.md", (text) => {
      assertMarkerPair(text, "release-version", "README.en.md");
      assertMarkerPair(text, "release-install", "README.en.md");
      return replaceExactlyOnce(replaceExactlyOnce(text,
        /(<!-- release-version:start -->\r?\n[\s\S]*?current public release is `v)\d+\.\d+\.\d+(`[^\r\n]*\r?\n<!-- release-version:end -->)/u,
        `$1${version}$2`,
        "README.en.md release-version",
      ),
        /(<!-- release-install:start -->\r?\n[\s\S]*?--ref v)\d+\.\d+\.\d+([\s\S]*?\r?\n<!-- release-install:end -->)/u,
        `$1${version}$2`,
        "README.en.md release-install",
      );
    }),
    await updateText("docs/roadmap.md", (text) => {
      assertMarkerPair(text, "release-version", "docs/roadmap.md");
      return replaceExactlyOnce(text,
        /(<!-- release-version:start -->\r?\n[\s\S]*?현재 공개 릴리스는 `v)\d+\.\d+\.\d+(`[^\r\n]*\r?\n<!-- release-version:end -->)/u,
        `$1${version}$2`,
        "roadmap release-version",
      );
    }),
  ];
}

export async function syncReleaseMetadata({ write = false } = {}) {
  const expected = await expectedReleaseFiles();
  const stale = [];
  for (const entry of expected) {
    const current = await readFile(entry.target, "utf8");
    if (current === entry.content) continue;
    stale.push(path.relative(ROOT, entry.target).split(path.sep).join("/"));
    if (write) await writeFile(entry.target, entry.content, "utf8");
  }
  if (!write && stale.length > 0) {
    throw new Error(`release metadata is stale: ${stale.join(", ")}`);
  }
  return stale;
}
