import { afterEach, describe, expect, it, vi } from "vitest";

// Counts the bytes read through each open of a transcript file; reads are attributed by descriptor.
const io = vi.hoisted(() => ({ paths: new Map<number, string>(), opens: [] as Array<{ file: string; bytes: number }>,
  current: new Map<number, { file: string; bytes: number }>() }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    openSync: ((...args: Parameters<typeof fs.openSync>) => {
      const descriptor = fs.openSync(...args);
      const open = { file: String(args[0]), bytes: 0 };
      io.opens.push(open);
      io.current.set(descriptor, open);
      return descriptor;
    }) as typeof fs.openSync,
    closeSync: ((descriptor: number) => { io.current.delete(descriptor); fs.closeSync(descriptor); }) as typeof fs.closeSync,
    readSync: ((descriptor: number, ...rest: unknown[]) => {
      const bytes = (fs.readSync as (...values: unknown[]) => number)(descriptor, ...rest);
      const open = io.current.get(descriptor);
      if (open) open.bytes += bytes;
      return bytes;
    }) as typeof fs.readSync,
  };
});

import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { observeClaudeExecution, type SessionModelRecord } from "../../mcp-server/src/host-attestation-hook.js";

// AGS3-D-0074: a long Claude Code session transcript (796 MB on one PC) was read in full to prove that a call's issuing
// message was absent, and the hook lagged. The hook now reads only the newest window, the lineage window: at most the
// last 2 MiB and 4000 lines. Missing an issuer outside it costs nothing: the main thread has no model floor, so its
// session model stands in, and a subagent never gets that stand-in. Cost is checked as bytes read, not time.
// All fixtures are synthetic.
const SESSION = "d0074-session";
const AGENT = "d0074-agent";
const CALL = "toolu_d0074_current";
const MODEL = "d0074-issuer-model";
const MiB = 1024 * 1024;
const WINDOW_BYTES = 2 * MiB;
const session: SessionModelRecord = { model: "d0074-session-model", source: "session-start", observedAt: "2026-11-08T00:00:00.000Z" };
const input = (transcript: string, fields: Record<string, unknown> = {}) => ({
  hook_event_name: "PreToolUse", session_id: SESSION, tool_use_id: CALL, transcript_path: transcript,
  tool_name: "mcp__agent_governance_suite__plan_workflow", tool_input: { taskId: "d0074" }, effort: { level: "high" }, ...fields,
});

function issuing(fields: Record<string, unknown> = {}, id = CALL): string {
  return JSON.stringify({ type: "assistant", sessionId: SESSION, effort: "high", ...fields,
    message: { model: MODEL, content: [{ type: "tool_use", id, name: "plan_workflow", input: {} }] } });
}

/** Unrelated rows of mixed sizes (some longer than 1 MiB), together at least `bytes` long. */
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
// Far longer than the window, so an issuer before it is outside the window.
const older = history(12 * MiB);
const newer = history(3 * MiB);

const directories: string[] = [];
afterEach(() => {
  io.opens.length = 0;
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
/** Bytes read through each open of `transcript`, in open order. */
const reads = (transcript: string) => io.opens.filter(open => open.file === transcript).map(open => open.bytes);

describe("AGS3-D-0074: a Claude call observation reads only the newest transcript window", () => {
  it("a root call whose issuer is outside the window gets the session model, reading at most the window per open", () => {
    const transcript = file(older + "\n" + issuing() + "\n" + newer + "\n");
    const size = statSync(transcript).size;
    const clock = polling();
    const cache = vi.fn(() => session);
    expect(observeClaudeExecution(input(transcript), { maxWaitMs: 300, pollIntervalMs: 100, ...clock, readSessionModel: cache }))
      .toEqual({ model: session.model, effort: "high", turnId: null, provenance: "claude-code:session-start" });
    expect(cache).toHaveBeenCalledTimes(1);
    const perOpen = reads(transcript);
    expect(perOpen.length).toBeGreaterThan(0);
    expect(Math.max(...perOpen)).toBeLessThanOrEqual(WINDOW_BYTES);
    expect(perOpen.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThan(size);
  });

  it("a rejected issuer outside the window no longer blocks the root fallback", () => {
    const transcript = file(older + "\n" + issuing({ isSidechain: true }) + "\n" + newer + "\n");
    const clock = polling();
    expect(observeClaudeExecution(input(transcript), { maxWaitMs: 300, pollIntervalMs: 100, ...clock, readSessionModel: () => session }))
      .toEqual({ model: session.model, effort: "high", turnId: null, provenance: "claude-code:session-start" });
    expect(Math.max(...reads(transcript))).toBeLessThanOrEqual(WINDOW_BYTES);
  });

  it("a subagent call whose issuer is outside the window stays unobserved and never reads the session model", () => {
    const transcript = file(older + "\n" + issuing({ agentId: AGENT, isSidechain: true }) + "\n" + newer + "\n");
    const clock = polling();
    const cache = vi.fn(() => session);
    expect(observeClaudeExecution(input(transcript, { agent_id: AGENT }), { maxWaitMs: 300, maxWaitWithoutSessionModelMs: 2000,
      pollIntervalMs: 100, ...clock, readSessionModel: cache })).toEqual({ unavailable: "CLAUDE_MODEL_UNOBSERVED" });
    expect(cache).not.toHaveBeenCalled();
    expect(clock.polls()).toBe(20);
    expect(Math.max(...reads(transcript))).toBeLessThanOrEqual(WINDOW_BYTES);
  });

  it("an issuer inside the newest 2 MiB but behind more than 4000 newer lines is outside the window", () => {
    const short = Array.from({ length: 4001 }, (_, index) => JSON.stringify({ type: "system", uuid: `line-${index}` })).join("\n");
    const transcript = file(issuing() + "\n" + short + "\n");
    expect(statSync(transcript).size).toBeLessThan(WINDOW_BYTES);
    const clock = polling();
    expect(observeClaudeExecution(input(transcript), { maxWaitMs: 300, pollIntervalMs: 100, ...clock, readSessionModel: () => session }))
      .toMatchObject({ model: session.model, provenance: "claude-code:session-start" });
  });

  it("an issuer at the end of a long transcript is observed from one window read", () => {
    const transcript = file(older + "\n" + issuing() + "\n");
    const cache = vi.fn(() => session);
    expect(observeClaudeExecution(input(transcript), { maxWaitMs: 0, now: () => new Date("2026-11-08T00:10:00.000Z"), readSessionModel: cache }))
      .toEqual({ model: MODEL, effort: "high", turnId: null, provenance: "claude-code:transcript-tool-use" });
    expect(cache).not.toHaveBeenCalled();
    expect(reads(transcript)).toEqual([WINDOW_BYTES]);
  });

  it("without a session model keeps polling the window until the host appends the issuer", () => {
    const transcript = file(older + "\n");
    const clock = polling(poll => { if (poll === 12) appendFileSync(transcript, issuing() + "\n"); });
    expect(observeClaudeExecution(input(transcript), { maxWaitMs: 300, maxWaitWithoutSessionModelMs: 2000, pollIntervalMs: 100,
      ...clock, readSessionModel: () => null })).toEqual({ model: MODEL, effort: "high", turnId: null, provenance: "claude-code:transcript-tool-use" });
    expect(clock.polls()).toBe(12);
    expect(Math.max(...reads(transcript))).toBeLessThanOrEqual(WINDOW_BYTES);
  });
});

describe("AGS3-D-0074: inside the window the issuer checks are unchanged", () => {
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

  it("a transcript replaced between polls is read from its new content", () => {
    const transcript = file(older + "\n");
    const clock = polling(poll => { if (poll === 1) writeFileSync(transcript, issuing({ sessionId: "another-session" }) + "\n"); });
    const cache = vi.fn(() => session);
    expect(observeClaudeExecution(input(transcript), { maxWaitMs: 300, pollIntervalMs: 100, ...clock, readSessionModel: cache }))
      .toEqual({ unavailable: "CLAUDE_ISSUING_MESSAGE_REJECTED" });
    expect(cache).not.toHaveBeenCalled();
  });
});
