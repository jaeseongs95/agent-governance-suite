import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { writeSync } from "node:fs";
import { failureContext, producerFailureReason, retainFailureSecondary, tagProducerFailure } from "./failure-diagnostics.js";

import type { KoreanProseGlossaryLookupRequestV1, KoreanProseGlossaryLookupResultV1 } from "../../contracts/types.js";

export const KOREAN_PROSE_GLOSSARY_MAX_SOURCE_LENGTH = 200_000;
export const KOREAN_PROSE_GLOSSARY_MAX_MATCHES = 256;

const DIGEST = /^[a-f0-9]{64}$/u;
const ENTRY_ID = /^[a-z0-9][a-z0-9-]*$/u;
const POLICIES = new Set(["protect", "prefer", "allow", "avoid"]);
const FORM_KINDS = new Set(["canonical", "alias", "discouraged"]);
const POLICY_FORM_KINDS: Record<GlossarySeedEntry["policy"], ReadonlySet<GlossarySeedForm["kind"]>> = {
  protect: new Set(["canonical"]),
  prefer: new Set(["alias"]),
  allow: new Set(["canonical", "alias"]),
  avoid: new Set(["discouraged"]),
};

export interface GlossarySeedForm {
  form: string;
  kind: "canonical" | "alias" | "discouraged";
}

export interface GlossarySeedEntry {
  entryId: string;
  canonicalForm: string;
  policy: "protect" | "prefer" | "allow" | "avoid";
  sourceRef: string;
  priority: number;
  active: boolean;
  forms: GlossarySeedForm[];
}

interface GlossaryMetadata {
  id: string;
  version: string;
  contentDigest: string;
}

interface LoadedGlossary {
  metadata: GlossaryMetadata;
  entries: GlossarySeedEntry[];
}

export interface KoreanProseGlossaryGateway {
  lookup(request: KoreanProseGlossaryLookupRequestV1): KoreanProseGlossaryLookupResultV1;
}

export class UnavailableKoreanProseGlossary implements KoreanProseGlossaryGateway {
  lookup(request: KoreanProseGlossaryLookupRequestV1): KoreanProseGlossaryLookupResultV1 {
    return unavailableResult(request.sourceText);
  }
}

export class SqliteKoreanProseGlossary implements KoreanProseGlossaryGateway {
  constructor(private readonly databasePath: string) {}

  lookup(request: KoreanProseGlossaryLookupRequestV1): KoreanProseGlossaryLookupResultV1 {
    const sourceDigest = sha256(request.sourceText);
    if (request.schemaVersion !== "1.0.0" || !DIGEST.test(request.sourceDigest) || request.sourceDigest !== sourceDigest) {
      throw new Error("The caller sourceDigest does not match sourceText.");
    }
    if (request.sourceText.length > KOREAN_PROSE_GLOSSARY_MAX_SOURCE_LENGTH) {
      return emptyResult("limit-exceeded", sourceDigest, null, "GLOSSARY_MATCH_LIMIT_EXCEEDED");
    }
    if (request.sourceText !== request.sourceText.normalize("NFC")) {
      return emptyResult("unsupported-normalization", sourceDigest, null, "GLOSSARY_UNSUPPORTED_NORMALIZATION");
    }

    let loaded: LoadedGlossary;
    try {
      loaded = loadGlossary(this.databasePath);
    } catch (error) {
      reportGlossaryFailure("lookup", error);
      return unavailableResult(request.sourceText);
    }

    const matches: KoreanProseGlossaryLookupResultV1["matches"] = [];
    for (const entry of loaded.entries) {
      if (!entry.active) continue;
      for (const form of entry.forms) {
        for (let start = request.sourceText.indexOf(form.form); start !== -1; start = request.sourceText.indexOf(form.form, start + 1)) {
          matches.push({
            start,
            end: start + form.form.length,
            entryId: entry.entryId,
            policy: entry.policy,
            canonicalForm: entry.canonicalForm,
            priority: entry.priority,
          });
          if (matches.length > KOREAN_PROSE_GLOSSARY_MAX_MATCHES) {
            return emptyResult("limit-exceeded", sourceDigest, loaded.metadata, "GLOSSARY_MATCH_LIMIT_EXCEEDED");
          }
        }
      }
    }
    matches.sort((left, right) => left.start - right.start || right.end - left.end || right.priority - left.priority || compareText(left.entryId, right.entryId));
    const status = matches.length === 0 ? "no-match" : "matched";
    const digestInput = {
      schemaVersion: "1.0.0",
      sourceDigest,
      glossary: loaded.metadata,
      matches,
    };
    return {
      schemaVersion: "1.0.0",
      status,
      sourceDigest,
      glossary: loaded.metadata,
      matches,
      matchSetDigest: sha256(stableJson(digestInput)),
      warnings: [],
    };
  }
}


/** Diagnostic output cannot turn the optional glossary into a hard dependency. */
function reportGlossaryFailure(phase: "lookup", error: unknown): void {
  try {
    writeSync(2, JSON.stringify({
      component: "korean-prose-glossary", phase, reason: producerFailureReason(error) ?? "GLOSSARY_UNAVAILABLE", context: failureContext(error),
    }) + "\n");
  } catch { /* A failed diagnostic sink does not replace the operation result/error. */ }
}

export function parseGlossarySeed(text: string): GlossarySeedEntry[] {
  const entries = text.split(/\r?\n/u).filter((line) => line.trim().length > 0).map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Glossary seed line ${index + 1} is not valid JSON.`);
    }
  });
  const normalized = entries.map((value, index) => validateSeedEntry(value, index + 1));
  const ids = new Set<string>();
  const activeForms = new Map<string, string>();
  for (const entry of normalized) {
    if (ids.has(entry.entryId)) throw new Error(`Duplicate glossary entryId: ${entry.entryId}`);
    ids.add(entry.entryId);
    if (!entry.active) continue;
    for (const form of entry.forms) {
      const owner = activeForms.get(form.form);
      if (owner && owner !== entry.entryId) throw new Error(`Conflicting active glossary form ${JSON.stringify(form.form)}.`);
      activeForms.set(form.form, entry.entryId);
    }
  }
  return normalized.sort((left, right) => compareText(left.entryId, right.entryId));
}

export function glossaryContentDigest(entries: GlossarySeedEntry[]): string {
  return sha256(stableJson(entries.map((entry) => ({
    entryId: entry.entryId,
    canonicalForm: entry.canonicalForm,
    policy: entry.policy,
    sourceRef: entry.sourceRef,
    priority: entry.priority,
    active: entry.active,
    forms: [...entry.forms].sort((left, right) => compareText(left.form, right.form) || compareText(left.kind, right.kind)),
  }))));
}

export function buildGlossaryDatabase(databasePath: string, entries: GlossarySeedEntry[], metadata: { id: string; version: string }): void {
  const database = new DatabaseSync(databasePath);
  let failure: { error: unknown } | null = null;
  try {
    database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE; BEGIN IMMEDIATE;");
    database.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;");
    database.exec("CREATE TABLE entries (entry_id TEXT PRIMARY KEY, canonical_form TEXT NOT NULL, policy TEXT NOT NULL CHECK (policy IN ('protect','prefer','allow','avoid')), source_ref TEXT NOT NULL, priority INTEGER NOT NULL, active INTEGER NOT NULL CHECK (active IN (0,1))) STRICT;");
    database.exec("CREATE TABLE forms (form_id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES entries(entry_id) ON DELETE CASCADE, surface TEXT NOT NULL, form_kind TEXT NOT NULL CHECK (form_kind IN ('canonical','alias','discouraged')), UNIQUE(entry_id, surface)) STRICT;");
    const insertMetadata = database.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)");
    const insertEntry = database.prepare("INSERT INTO entries(entry_id, canonical_form, policy, source_ref, priority, active) VALUES (?, ?, ?, ?, ?, ?)");
    const insertForm = database.prepare("INSERT INTO forms(form_id, entry_id, surface, form_kind) VALUES (?, ?, ?, ?)");
    const digest = glossaryContentDigest(entries);
    const metadataValues: Array<[string, string]> = [["schemaVersion", "1.0.0"], ["glossaryId", metadata.id], ["glossaryVersion", metadata.version], ["contentDigest", digest]];
    for (const [key, value] of metadataValues) insertMetadata.run(key, value);
    for (const entry of entries) {
      insertEntry.run(entry.entryId, entry.canonicalForm, entry.policy, entry.sourceRef, entry.priority, entry.active ? 1 : 0);
      [...entry.forms].sort((left, right) => compareText(left.form, right.form) || compareText(left.kind, right.kind)).forEach((form, index) => {
        insertForm.run(`${entry.entryId}:${String(index + 1).padStart(3, "0")}`, entry.entryId, form.form, form.kind);
      });
    }
    database.exec("COMMIT;");
  } catch (error) {
    failure = { error };
    if (error instanceof Error) tagProducerFailure(error, "GLOSSARY_BUILD_FAILED");
    try { database.exec("ROLLBACK;"); }
    catch (rollback) {
      if (rollback instanceof Error) tagProducerFailure(rollback, "GLOSSARY_ROLLBACK_FAILED");
      retainFailureSecondary(error, rollback);
    }
  } finally {
    try { database.close(); }
    catch (close) {
      if (close instanceof Error) tagProducerFailure(close, "GLOSSARY_CLOSE_FAILED");
      if (failure) retainFailureSecondary(failure.error, close);
      else failure = { error: close };
    }
  }
  if (failure) throw failure.error;
}

export function checkGlossaryDatabase(databasePath: string, expectedEntries: GlossarySeedEntry[]): GlossaryMetadata {
  const loaded = loadGlossary(databasePath);
  if (stableJson(loaded.entries) !== stableJson(expectedEntries)) {
    throw tagProducerFailure(new Error("Glossary SQLite rows do not match the reviewed JSONL seed."), "GLOSSARY_SEED_MISMATCH");
  }
  return loaded.metadata;
}

function loadGlossary(databasePath: string): LoadedGlossary {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let failure: { error: unknown } | null = null;
  let loaded: LoadedGlossary | undefined;
  try {
    database.exec("PRAGMA query_only = ON;");
    const integrity = database.prepare("PRAGMA integrity_check").get() as Record<string, unknown> | undefined;
    if (!integrity || Object.values(integrity)[0] !== "ok") throw tagProducerFailure(new Error("Glossary database integrity check failed."), "GLOSSARY_INTEGRITY_FAILED");
    const metadataRows = database.prepare("SELECT key, value FROM metadata ORDER BY key").all() as Array<{ key: string; value: string }>;
    const metadata = new Map(metadataRows.map((row) => [row.key, row.value]));
    if (metadata.get("schemaVersion") !== "1.0.0" || !metadata.get("glossaryId") || !metadata.get("glossaryVersion") || !DIGEST.test(metadata.get("contentDigest") ?? "")) throw tagProducerFailure(new Error("Glossary metadata is invalid."), "GLOSSARY_METADATA_INVALID");
    const rows = database.prepare("SELECT entry_id, canonical_form, policy, source_ref, priority, active FROM entries ORDER BY entry_id").all() as Array<Record<string, unknown>>;
    const formRows = database.prepare("SELECT entry_id, surface, form_kind FROM forms ORDER BY entry_id, form_id").all() as Array<Record<string, unknown>>;
    const entries = rows.map((row) => ({
      entryId: String(row.entry_id),
      canonicalForm: String(row.canonical_form),
      policy: String(row.policy) as GlossarySeedEntry["policy"],
      sourceRef: String(row.source_ref),
      priority: Number(row.priority),
      active: row.active === 1,
      forms: formRows.filter((form) => form.entry_id === row.entry_id).map((form) => ({ form: String(form.surface), kind: String(form.form_kind) as GlossarySeedForm["kind"] })),
    }));
    const validated = parseGlossarySeed(entries.map((entry) => JSON.stringify(entry)).join("\n"));
    if (glossaryContentDigest(validated) !== metadata.get("contentDigest")) throw tagProducerFailure(new Error("Glossary content digest is stale."), "GLOSSARY_DIGEST_STALE");
    loaded = { metadata: { id: metadata.get("glossaryId")!, version: metadata.get("glossaryVersion")!, contentDigest: metadata.get("contentDigest")! }, entries: validated };
  } catch (error) {
    failure = { error };
    if (error instanceof Error) tagProducerFailure(error, "GLOSSARY_LOAD_FAILED");
  } finally {
    try { database.close(); }
    catch (close) {
      if (close instanceof Error) tagProducerFailure(close, "GLOSSARY_CLOSE_FAILED");
      if (failure) retainFailureSecondary(failure.error, close);
      else failure = { error: close };
    }
  }
  if (failure) throw failure.error;
  return loaded!;
}

function validateSeedEntry(value: unknown, line: number): GlossarySeedEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Glossary seed line ${line} must be an object.`);
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item).sort().join(",");
  if (keys !== ["active", "canonicalForm", "entryId", "forms", "policy", "priority", "sourceRef"].sort().join(",")) throw new Error(`Glossary seed line ${line} has unexpected or missing fields.`);
  if (typeof item.entryId !== "string" || !ENTRY_ID.test(item.entryId)) throw new Error(`Glossary seed line ${line} has an invalid entryId.`);
  if (typeof item.canonicalForm !== "string" || item.canonicalForm.length === 0 || item.canonicalForm !== item.canonicalForm.normalize("NFC")) throw new Error(`Glossary seed line ${line} has a non-NFC or empty canonicalForm.`);
  if (typeof item.policy !== "string" || !POLICIES.has(item.policy)) throw new Error(`Glossary seed line ${line} has an invalid policy.`);
  if (typeof item.sourceRef !== "string" || item.sourceRef.trim().length === 0) throw new Error(`Glossary seed line ${line} is missing sourceRef.`);
  try {
    if (new URL(item.sourceRef).protocol !== "https:") throw new Error();
  } catch {
    throw new Error(`Glossary seed line ${line} sourceRef must be an absolute HTTPS URL.`);
  }
  if (!Number.isInteger(item.priority) || Number(item.priority) < 0 || Number(item.priority) > 1000) throw new Error(`Glossary seed line ${line} has an invalid priority.`);
  if (typeof item.active !== "boolean" || !Array.isArray(item.forms) || item.forms.length === 0) throw new Error(`Glossary seed line ${line} has invalid active/forms fields.`);
  const forms = item.forms.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Glossary seed line ${line} form ${index + 1} is invalid.`);
    const form = raw as Record<string, unknown>;
    if (Object.keys(form).sort().join(",") !== "form,kind" || typeof form.form !== "string" || form.form.length === 0 || form.form !== form.form.normalize("NFC") || typeof form.kind !== "string" || !FORM_KINDS.has(form.kind)) throw new Error(`Glossary seed line ${line} form ${index + 1} is invalid or non-NFC.`);
    return { form: form.form, kind: form.kind as GlossarySeedForm["kind"] };
  });
  if (new Set(forms.map((form) => form.form)).size !== forms.length) throw new Error(`Glossary seed line ${line} has duplicate forms.`);
  const policy = item.policy as GlossarySeedEntry["policy"];
  if (forms.some((form) => !POLICY_FORM_KINDS[policy].has(form.kind))) throw new Error(`Glossary seed line ${line} has a form kind that conflicts with policy ${policy}.`);
  if ((policy === "protect" || policy === "allow") && !forms.some((form) => form.kind === "canonical" && form.form === item.canonicalForm)) {
    throw new Error(`Glossary seed line ${line} must include its canonicalForm as a canonical form.`);
  }
  if ((policy === "prefer" || policy === "avoid") && forms.some((form) => form.form === item.canonicalForm)) {
    throw new Error(`Glossary seed line ${line} must not flag its canonicalForm as a ${policy} source form.`);
  }
  return {
    entryId: item.entryId,
    canonicalForm: item.canonicalForm,
    policy,
    sourceRef: item.sourceRef,
    priority: Number(item.priority),
    active: item.active,
    forms: [...forms].sort((left, right) => compareText(left.form, right.form) || compareText(left.kind, right.kind)),
  };
}

function emptyResult(status: "limit-exceeded" | "unsupported-normalization", sourceDigest: string, glossary: GlossaryMetadata | null, warning: "GLOSSARY_MATCH_LIMIT_EXCEEDED" | "GLOSSARY_UNSUPPORTED_NORMALIZATION"): KoreanProseGlossaryLookupResultV1 {
  return { schemaVersion: "1.0.0", status, sourceDigest, glossary, matches: [], matchSetDigest: null, warnings: [warning] };
}

function unavailableResult(sourceText: string): KoreanProseGlossaryLookupResultV1 {
  return { schemaVersion: "1.0.0", status: "unavailable", sourceDigest: sha256(sourceText), glossary: null, matches: [], matchSetDigest: null, warnings: ["GLOSSARY_UNAVAILABLE"] };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareText(left, right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
