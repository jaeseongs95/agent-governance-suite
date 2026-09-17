import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildGlossaryDatabase,
  checkGlossaryDatabase,
  parseGlossarySeed,
  SqliteKoreanProseGlossary,
} from "../../mcp-server/src/korean-prose-glossary.js";

const resourceRoot = path.resolve(import.meta.dirname, "../../skills/korean-prose-editor/resources");
const databasePath = path.join(resourceRoot, "korean-prose-glossary.sqlite3");
const seedPath = path.join(resourceRoot, "glossary.seed.jsonl");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

describe("Korean prose glossary", () => {
  it("keeps reviewed JSONL and packaged SQLite logically identical", async () => {
    const entries = parseGlossarySeed(await readFile(seedPath, "utf8"));
    expect(checkGlossaryDatabase(databasePath, entries)).toMatchObject({ id: "korean-prose-core", version: "1.2.1" });
    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all()).toEqual([{ name: "entries" }, { name: "forms" }, { name: "metadata" }]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM entries WHERE active = 1").get()).toEqual({ count: 242 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM forms").get()).toEqual({ count: 248 });
    expect(database.prepare("SELECT policy, COUNT(*) AS count FROM entries WHERE active = 1 GROUP BY policy ORDER BY policy").all()).toEqual([
      { policy: "allow", count: 68 },
      { policy: "avoid", count: 8 },
      { policy: "prefer", count: 4 },
      { policy: "protect", count: 162 },
    ]);
    database.close();
  });

  it("distinguishes no-match from invalid caller digests", () => {
    const glossary = new SqliteKoreanProseGlossary(databasePath);
    const sourceText = "일반 문장입니다.";
    expect(glossary.lookup({ schemaVersion: "1.0.0", sourceText, sourceDigest: digest(sourceText) })).toMatchObject({ status: "no-match", matches: [], warnings: [] });
    expect(() => glossary.lookup({ schemaVersion: "1.0.0", sourceText, sourceDigest: "0".repeat(64) })).toThrow(/does not match/u);
  });

  it("returns deterministic UTF-16 ranges including nested terms", () => {
    const sourceText = "😀 Model Context Protocol(MCP)는 SQLite를 쓴다.";
    const result = new SqliteKoreanProseGlossary(databasePath).lookup({ schemaVersion: "1.0.0", sourceText, sourceDigest: digest(sourceText) });
    expect(result.status).toBe("matched");
    expect(result.matches.map(({ entryId, start, end }) => ({ entryId, start, end }))).toEqual([
      { entryId: "model-context-protocol", start: 3, end: 25 },
      { entryId: "mcp", start: 26, end: 29 },
      { entryId: "sqlite", start: 32, end: 38 },
    ]);
    expect(result.matchSetDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps overlapping expressions as separate ordered matches", () => {
    const sourceText = "JSON Schema";
    const result = new SqliteKoreanProseGlossary(databasePath).lookup({ schemaVersion: "1.0.0", sourceText, sourceDigest: digest(sourceText) });
    expect(result.matches.map(({ entryId, start, end }) => ({ entryId, start, end }))).toEqual([
      { entryId: "json-schema", start: 0, end: 11 },
      { entryId: "json", start: 0, end: 4 },
    ]);
  });

  it("maps all four policies to reviewed canonical forms", () => {
    const sourceText = "OpenAI의 데이터 베이스와 워크플로우를 스킬로 설명한다.";
    const result = new SqliteKoreanProseGlossary(databasePath).lookup({ schemaVersion: "1.0.0", sourceText, sourceDigest: digest(sourceText) });
    expect(result.matches.map(({ entryId, policy, canonicalForm }) => ({ entryId, policy, canonicalForm }))).toEqual([
      { entryId: "openai", policy: "protect", canonicalForm: "OpenAI" },
      { entryId: "database-ko", policy: "avoid", canonicalForm: "데이터베이스" },
      { entryId: "workflow-ko", policy: "prefer", canonicalForm: "워크플로" },
      { entryId: "skill-ko", policy: "allow", canonicalForm: "스킬" },
    ]);
  });

  it("uses the official GitHub terms and no longer matches the deactivated receipt-metaphor entry", async () => {
    // completion-result-ko was deactivated after the 2026-09-18 deliberation: its sourceRef did not support
    // the mapping and the phrase has no observed usage outside this repository. The metaphor stays a
    // selection-policy concern, not a glossary match.
    const entries = parseGlossarySeed(await readFile(seedPath, "utf8"));
    const sourceText = "@mention 뒤에 완료 영수증을 표시한다.";
    const result = new SqliteKoreanProseGlossary(databasePath).lookup({ schemaVersion: "1.0.0", sourceText, sourceDigest: digest(sourceText) });
    expect(result.matches.map(({ entryId, policy, canonicalForm }) => ({ entryId, policy, canonicalForm }))).toEqual([
      { entryId: "github-glossary-001", policy: "protect", canonicalForm: "@mention" },
    ]);
    const inactive = entries.find((entry) => entry.entryId === "completion-result-ko");
    expect(inactive).toMatchObject({ active: false, policy: "avoid", canonicalForm: "완료 결과" });
  });

  it("returns empty non-partial results for normalization and size limits", () => {
    const glossary = new SqliteKoreanProseGlossary(databasePath);
    const nfd = "스킬".normalize("NFD");
    expect(glossary.lookup({ schemaVersion: "1.0.0", sourceText: nfd, sourceDigest: digest(nfd) })).toMatchObject({ status: "unsupported-normalization", matches: [], matchSetDigest: null });
    const long = "가".repeat(200_001);
    expect(glossary.lookup({ schemaVersion: "1.0.0", sourceText: long, sourceDigest: digest(long) })).toMatchObject({ status: "limit-exceeded", matches: [], matchSetDigest: null });
    const repeated = "MCP ".repeat(257);
    expect(glossary.lookup({ schemaVersion: "1.0.0", sourceText: repeated, sourceDigest: digest(repeated) })).toMatchObject({ status: "limit-exceeded", matches: [], matchSetDigest: null });
  });

  it("falls back cleanly for missing, corrupt, and stale databases", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "korean-glossary-test-"));
    try {
      const corrupt = path.join(directory, "corrupt.sqlite3");
      await writeFile(corrupt, "not sqlite", "utf8");
      const sourceText = "MCP";
      for (const target of [path.join(directory, "missing.sqlite3"), corrupt]) {
        expect(new SqliteKoreanProseGlossary(target).lookup({ schemaVersion: "1.0.0", sourceText, sourceDigest: digest(sourceText) })).toMatchObject({ status: "unavailable", matches: [], warnings: ["GLOSSARY_UNAVAILABLE"] });
      }
      const stale = path.join(directory, "stale.sqlite3");
      await copyFile(databasePath, stale);
      const database = new DatabaseSync(stale);
      database.prepare("UPDATE metadata SET value = ? WHERE key = 'contentDigest'").run("0".repeat(64));
      database.close();
      expect(new SqliteKoreanProseGlossary(stale).lookup({ schemaVersion: "1.0.0", sourceText, sourceDigest: digest(sourceText) }).status).toBe("unavailable");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("opens the shipped database read-only", () => {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA query_only = ON");
    expect(() => database.prepare("UPDATE metadata SET value = 'x'").run()).toThrow();
    database.close();
  });

  it.each([
    ["duplicate id", (line: Record<string, unknown>) => `${JSON.stringify(line)}\n${JSON.stringify(line)}`],
    ["invalid policy", (line: Record<string, unknown>) => JSON.stringify({ ...line, policy: "replace" })],
    ["missing source", (line: Record<string, unknown>) => JSON.stringify({ ...line, sourceRef: "" })],
    ["non-HTTPS source", (line: Record<string, unknown>) => JSON.stringify({ ...line, sourceRef: "http://example.test/source" })],
    ["non NFC", (line: Record<string, unknown>) => JSON.stringify({ ...line, canonicalForm: "가".normalize("NFD") })],
    ["policy/form-kind mismatch", (line: Record<string, unknown>) => JSON.stringify({ ...line, forms: [{ form: line.canonicalForm, kind: "alias" }] })],
    ["missing canonical form", (line: Record<string, unknown>) => JSON.stringify({ ...line, canonicalForm: "Different" })],
  ])("rejects %s seed data", async (_name, mutate) => {
    const line = JSON.parse((await readFile(seedPath, "utf8")).split(/\r?\n/u)[0]!);
    expect(() => parseGlossarySeed(mutate(line))).toThrow();
  });

  it("rejects conflicting active forms", async () => {
    const line = JSON.parse((await readFile(seedPath, "utf8")).split(/\r?\n/u)[0]!);
    const other = { ...line, entryId: "other" };
    expect(() => parseGlossarySeed(`${JSON.stringify(line)}\n${JSON.stringify(other)}`)).toThrow(/Conflicting/u);
  });

  it("builds a fresh database with the same logical digest", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "korean-glossary-build-"));
    try {
      const target = path.join(directory, "glossary.sqlite3");
      const entries = parseGlossarySeed(await readFile(seedPath, "utf8"));
      buildGlossaryDatabase(target, entries, { id: "korean-prose-core", version: "1.2.1" });
      expect(checkGlossaryDatabase(target, entries).contentDigest).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
