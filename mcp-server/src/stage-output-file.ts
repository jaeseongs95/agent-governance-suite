import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";

import { type StageOutputFileV1, WorkflowContractError } from "../../contracts/types.js";

/** Provider outputs larger than this are not accepted by reference either. */
export const MAX_STAGE_OUTPUT_FILE_BYTES = 16 * 1024 * 1024;

export type StageOutputFileReader = (locator: string) => Buffer;

function unreadable(locator: string): WorkflowContractError {
  return new WorkflowContractError("INVALID_INPUT", "outputFile.locator is not a readable regular local file of at most 16 MiB.", { locator });
}

/**
 * Reads a caller-named local file. Size and type are checked on the opened
 * descriptor and the read is bounded, so the file cannot grow or change type
 * between the check and the read. Network (UNC) paths are refused.
 */
export function readLocalStageOutputFile(locator: string): Buffer {
  if (!path.isAbsolute(locator)) {
    throw new WorkflowContractError("INVALID_INPUT", "outputFile.locator must be an absolute local path.");
  }
  if (/^(?:\\\\|\/\/)/u.test(locator)) {
    throw new WorkflowContractError("INVALID_INPUT", "outputFile.locator must not be a network path.");
  }
  let descriptor: number | null = null;
  try {
    descriptor = openSync(locator, "r");
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size > MAX_STAGE_OUTPUT_FILE_BYTES) throw unreadable(locator);
    const buffer = Buffer.alloc(MAX_STAGE_OUTPUT_FILE_BYTES + 1);
    let length = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > MAX_STAGE_OUTPUT_FILE_BYTES) throw unreadable(locator);
    }
    return buffer.subarray(0, length);
  } catch (error) {
    if (error instanceof WorkflowContractError) throw error;
    throw unreadable(locator);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
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
  if (bytes.length > MAX_STAGE_OUTPUT_FILE_BYTES) throw unreadable(reference.locator);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== reference.digest) {
    // The file's actual digest is not echoed back.
    throw new WorkflowContractError("INTEGRITY_FAILED", "outputFile content does not match its digest.", {
      locator: reference.locator,
      expected: reference.digest,
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
