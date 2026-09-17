#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { contractErrors, validateWorkspaceProfile } from "./schema-validation.mjs";

export function validateProfile(profile) {
  const errors = [];
  if (!validateWorkspaceProfile(profile)) {
    errors.push(...contractErrors(validateWorkspaceProfile).map((error) => `schema${error}`));
    return errors;
  }
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return errors;
  const evidence = new Map();
  for (const item of profile.evidenceIndex ?? []) {
    const ref = `${item.locator}#${item.digest}`;
    if (evidence.has(ref) || [...evidence.values()].some((entry) => entry.locator === item.locator)) errors.push(`duplicate evidence locator: ${item.locator}`);
    evidence.set(ref, item);
  }
  const checkRefs = (refs, criterion, expectedKind = null) => {
    for (const ref of refs ?? []) {
      const item = evidence.get(ref);
      if (!item) errors.push(`${criterion} references missing evidence: ${ref}`);
      else if (expectedKind && item.kind !== expectedKind) errors.push(`${criterion} requires ${expectedKind} evidence: ${ref}`);
    }
  };
  for (const ecosystem of profile.ecosystems ?? []) checkRefs(ecosystem.manifestRefs, `ecosystem ${ecosystem.language}`);
  for (const item of profile.structure ?? []) checkRefs(item.evidenceRefs, `structure ${item.role}`, "directory");
  for (const convention of profile?.conventions ?? []) {
    if (convention.confidence === "confirmed" && !convention.evidenceRefs?.length) errors.push(`confirmed convention lacks evidence: ${convention.subject}`);
    checkRefs(convention.evidenceRefs, `convention ${convention.subject}`);
  }
  for (const command of profile.commands ?? []) checkRefs([command.sourceRef], `command ${command.command}`);
  return errors;
}

async function readInput() {
  const index = process.argv.indexOf("--input");
  if (index >= 0) return JSON.parse(await readFile(process.argv[index + 1], "utf8"));
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return JSON.parse(raw);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
const profile = await readInput();
const errors = validateProfile(profile);
process.stdout.write(`${JSON.stringify({ valid: errors.length === 0, errors })}\n`);
process.exitCode = errors.length ? 1 : 0;
}
