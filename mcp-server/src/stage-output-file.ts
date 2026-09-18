import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { type StageOutputFileV1, WorkflowContractError } from "../../contracts/types.js";

/** Provider outputs larger than this are not accepted by reference either. */
export const MAX_STAGE_OUTPUT_FILE_BYTES = 16 * 1024 * 1024;

export type StageOutputFileReader = (locator: string) => Buffer;

/** Reads a caller-named local file; only its digest and parsed JSON are used, never echoed back. */
export function readLocalStageOutputFile(locator: string): Buffer {
  if (!path.isAbsolute(locator)) {
    throw new WorkflowContractError("INVALID_INPUT", "outputFile.locator must be an absolute local path.");
  }
  let size: number;
  try {
    const stats = statSync(locator);
    if (!stats.isFile()) throw new Error("not a regular file");
    size = stats.size;
  } catch {
    throw new WorkflowContractError("INVALID_INPUT", "outputFile.locator is not a readable regular file.", { locator });
  }
  if (size > MAX_STAGE_OUTPUT_FILE_BYTES) {
    throw new WorkflowContractError("INVALID_INPUT", "outputFile exceeds the 16 MiB limit.", { locator });
  }
  try {
    return readFileSync(locator);
  } catch {
    throw new WorkflowContractError("INVALID_INPUT", "outputFile.locator could not be read.", { locator });
  }
}

/**
 * Loads output.output from a stage output file after checking its digest.
 * The caller validates the returned object exactly like inline output.
 */
export function loadStageOutputFile(
  reference: StageOutputFileV1,
  read: StageOutputFileReader = readLocalStageOutputFile,
): Record<string, unknown> {
  const bytes = read(reference.locator);
  if (bytes.length > MAX_STAGE_OUTPUT_FILE_BYTES) {
    throw new WorkflowContractError("INVALID_INPUT", "outputFile exceeds the 16 MiB limit.", { locator: reference.locator });
  }
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== reference.digest) {
    throw new WorkflowContractError("INTEGRITY_FAILED", "outputFile content does not match its digest.", {
      locator: reference.locator,
      expected: reference.digest,
      actual: digest,
    });
  }
  let parsed: unknown;
  try {
    // Files written by Windows tools may start with a byte order mark.
    parsed = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch {
    throw new WorkflowContractError("INVALID_INPUT", "outputFile is not valid JSON.", { locator: reference.locator });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkflowContractError("INVALID_INPUT", "outputFile must contain a JSON object.", { locator: reference.locator });
  }
  return parsed as Record<string, unknown>;
}
