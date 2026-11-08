import { afterEach, describe, expect, it, vi } from "vitest";

// Counts the bytes the hook reads from each transcript file; reads are attributed by descriptor.
const io = vi.hoisted(() => ({ paths: new Map<number, string>(), bytes: new Map<string, number>() }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    openSync: ((...args: Parameters<typeof fs.openSync>) => {
      const descriptor = fs.openSync(...args);
      io.paths.set(descriptor, String(args[0]));
      return descriptor;
    }) as typeof fs.openSync,
    closeSync: ((descriptor: number) => { io.paths.delete(descriptor); fs.closeSync(descriptor); }) as typeof fs.closeSync,
    readSync: ((descriptor: number, ...rest: unknown[]) => {
      const bytes = (fs.readSync as (...values: unknown[]) => number)(descriptor, ...rest);
      const file = io.paths.get(descriptor);
      if (file) io.bytes.set(file, (io.bytes.get(file) ?? 0) + bytes);
      return bytes;
    }) as typeof fs.readSync,
  };
});

import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { observeClaudeExecution, type SessionModelRecord } from "../../mcp-server/src/host-attestation-hook.js";

// AGS3-D-0074: an interactive Claude Code session writes the issuing message only after the PreToolUse hook starts.
// The hook then read a long transcript in full once per poll and once more for the probe, and a 755 MB transcript
// exceeded the 10 s hook limit. The cost is checked as bytes read, not as time. All fixtures are synthetic.
const SESSION = "d0074-session";
const CALL = "toolu_d0074_current";
const MODEL = "d0074-issuer-model";
const MiB = 1024 * 1024;
const session: SessionModelRecord = { model: "d0074-session-model", source: "session-start", observedAt: "2026-11-08T00:00:00.000Z" };
const input = (transcript: string) => ({
  hook_event_name: "PreToolUse", session_id: SESSION, tool_use_id: CALL, transcript_path: transcript,
  tool_name: "mcp__agent_governance_suite__plan_workflow", tool_input: { taskId: "d0074" }, effort: { level: "high" },
});

function issuing(fields: Record<string, unknown> = {}, id = CALL): string {
  return JSON.stringify({ type: "assistant", sessionId: SESSION, effort: "high", ...fields,
    message: { model: MODEL, content: [{ type: "tool_use", id, name: "plan_workflow", input: {} }] } });
}

/** Unrelated rows of mixed sizes (some longer than the 1 MiB read window), together at least `bytes` long. */
function history(bytes: number): string {
  const rows: string[] = [];
  let total = 0;
  for (let index = 0; total < bytes; index += 1) {
    const size = index % 40 === 7 ? MiB + 4099 : 512 + (index * 37) % 4000;
    const row = JSON.stringify({ type: "user", sessionId: SESSION, uuid: `history-${index}`,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_history_${index}`, content: "가".repeat(size / 3 | 0) }] } });
    rows.push(row);
    total += Buffer.byteLength(row) + 1;
  }
  return rows.join("\n");
}
const older = history(6 * MiB);

const directories: string[] = [];
afterEach(() => {
  io.bytes.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function file(content: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-d0074-"));
  directories.push(directory);
  const transcript = path.join(directory, "transcript.jsonl");
  writeFileSync(transcript, content, "utf8");
  return transcript;
}

/** A clock the hook's own sleep advances, so polling is deterministic; `onSleep` runs at each poll (the host writing). */
function polling(onSleep: (poll: number) => void = () => {}) {
  let clockMs = Date.parse("2026-11-08T00:10:00.000Z");
  let polls = 0;
  return {
    now: () => new Date(clockMs),
    sleep: (milliseconds: number) => { clockMs += milliseconds; onSleep(++polls); },
    polls: () => polls,
  };
}
const read = (transcript: string) => io.bytes.get(transcript) ?? 0;
/** Each search and probe may re-read the newline before the bytes already read (the last line here is empty). */
const slack = (polls: number) => 4 * (polls + 2);

describe("AGS3-D-0074: a Claude call whose issuing message is not written yet reads the transcript at most once", () => {
  it("falls back to the session model after one pass, however many polls and probes run", () => {
    const transcript = file(older + "\n" + issuing({}, "toolu_previous_call") + "\n");
    const size = statSync(transcript).size;
    const clock = polling();
    const cache = vi.fn(() => session);
    expect(observeClaudeExecution(input(transcript), { maxWaitMs: 300, pollIntervalMs: 100, ...clock, readSessionModel: cache }))
      .toEqual({ model: session.model, effort: "high", turnId: null, provenance: "claude-code:session-start" });
    expect(clock.polls()).toBe(3);
    expect(read(transcript)).toBeLessThanOrEqual(size + slack(clock.polls()));
  });

  it("without a session model keeps polling and reads only what the host appends, then observes the issuer", () => {
    const transcript = file(older + "\n");
    const size = statSync(transcript).size;
    const appended = Buffer.byteLength(issuing()) + 1;
    const clock = polling(poll => { if (poll === 12) appendFileSync(transcript, issuing() + "\n"); });
    expect(observeClaudeExecution(input(transcript), { maxWaitMs: 300, maxWaitWithoutSessionModelMs: 2000, pollIntervalMs: 100,
      ...clock, readSessionModel: () => null })).toEqual({ model: MODEL, effort: "high", turnId: null, provenance: "claude-code:transcript-tool-use" });
    expect(clock.polls()).toBe(12);
    expect(read(transcript)).toBeLessThanOrEqual(size + appended + slack(clock.polls()));
  });

  it("without a session model and without an issuer stays unobserved after one pass", () => {
    const transcript = file(older + "\n");
    const size = statSync(transcript).size;
    const clock = polling();
    expect(observeClaudeExecution(input(transcript), { maxWaitMs: 300, maxWaitWithoutSessionModelMs: 2000, pollIntervalMs: 100,
      ...clock, readSessionModel: () => null })).toEqual({ unavailable: "CLAUDE_MODEL_UNOBSERVED" });
    expect(clock.polls()).toBe(20);
    expect(read(transcript)).toBeLessThanOrEqual(size + slack(clock.polls()));
  });
});

describe("AGS3-D-0074: reading only the new bytes keeps the whole-history safety conditions", () => {
  it.each([
    ["another session", { sessionId: "another-session" }],
    ["a sidechain", { isSidechain: true }],
  ])("an issuer from %s appended during the wait still blocks the fallback", (_label, fields) => {
    const transcript = file(older + "\n");
    const clock = polling(poll => { if (poll === 1) appendFileSync(transcript, issuing(fields) + "\n"); });
    const cache = vi.fn(() => session);
    expect(observeClaudeExecution(input(transcript), { maxWaitMs: 300, pollIntervalMs: 100, ...clock, readSessionModel: cache }))
      .toEqual({ unavailable: "CLAUDE_ISSUING_MESSAGE_REJECTED" });
    expect(cache).not.toHaveBeenCalled();
  });

  it("a rejected issuer before the bytes already read still blocks the fallback on later polls", () => {
    const transcript = file(issuing({ isSidechain: true }) + "\n" + older + "\n");
    const clock = polling(poll => appendFileSync(transcript, issuing({}, `toolu_unrelated_${poll}`) + "\n"));
    const cache = vi.fn(() => session);
    expect(observeClaudeExecution(input(transcript), { maxWaitMs: 300, pollIntervalMs: 100, ...clock, readSessionModel: cache }))
      .toEqual({ unavailable: "CLAUDE_ISSUING_MESSAGE_REJECTED" });
    expect(cache).not.toHaveBeenCalled();
  });

  it("an incomplete current issuer far before the bytes already read stays indeterminate", () => {
    const damaged = issuing().slice(0, issuing().indexOf(CALL) + 5);
    const transcript = file(damaged + "\n" + older + "\n");
    const size = statSync(transcript).size;
    const clock = polling();
    const cache = vi.fn(() => session);
    expect(observeClaudeExecution(input(transcript), { maxWaitMs: 300, pollIntervalMs: 100, ...clock, readSessionModel: cache }))
      .toEqual({ unavailable: "CURRENT_CALL_INCOMPLETE" });
    expect(cache).not.toHaveBeenCalled();
    expect(read(transcript)).toBeLessThanOrEqual(size + slack(clock.polls()));
  });

  it("an issuing row the host is still writing is read again until it is complete", () => {
    const row = issuing();
    const half = row.slice(0, row.indexOf(CALL) + 5);
    const transcript = file(older + "\n" + half);
    const clock = polling(poll => { if (poll === 2) appendFileSync(transcript, row.slice(half.length) + "\n"); });
    const cache = vi.fn(() => session);
    expect(observeClaudeExecution(input(transcript), { maxWaitMs: 300, pollIntervalMs: 100, ...clock, readSessionModel: cache }))
      .toEqual({ model: MODEL, effort: "high", turnId: null, provenance: "claude-code:transcript-tool-use" });
    expect(cache).not.toHaveBeenCalled();
  });

  it("an issuing row still unfinished after the wait stays indeterminate instead of falling back", () => {
    const row = issuing();
    const transcript = file(older + "\n" + row.slice(0, row.indexOf(CALL) + 5));
    const clock = polling();
    const cache = vi.fn(() => session);
    expect(observeClaudeExecution(input(transcript), { maxWaitMs: 300, pollIntervalMs: 100, ...clock, readSessionModel: cache }))
      .toEqual({ unavailable: "CURRENT_CALL_INCOMPLETE" });
    expect(cache).not.toHaveBeenCalled();
  });

  it("a transcript rewritten in place between polls is read again in full", () => {
    const transcript = file(older + "\n");
    const size = statSync(transcript).size;
    // Same file, longer, with the issuer before the bytes already read and no newline where they ended.
    const rewritten = issuing() + "\n" + " ".repeat(size + 64);
    const clock = polling(poll => { if (poll === 1) writeFileSync(transcript, rewritten); });
    const cache = vi.fn(() => session);
    expect(observeClaudeExecution(input(transcript), { maxWaitMs: 300, pollIntervalMs: 100, ...clock, readSessionModel: cache }))
      .toEqual({ model: MODEL, effort: "high", turnId: null, provenance: "claude-code:transcript-tool-use" });
    expect(cache).not.toHaveBeenCalled();
  });

  it("a transcript truncated between polls is read again in full", () => {
    const transcript = file(older + "\n");
    const clock = polling(poll => { if (poll === 1) writeFileSync(transcript, issuing({ sessionId: "another-session" }) + "\n"); });
    const cache = vi.fn(() => session);
    expect(observeClaudeExecution(input(transcript), { maxWaitMs: 300, pollIntervalMs: 100, ...clock, readSessionModel: cache }))
      .toEqual({ unavailable: "CLAUDE_ISSUING_MESSAGE_REJECTED" });
    expect(cache).not.toHaveBeenCalled();
  });
});
