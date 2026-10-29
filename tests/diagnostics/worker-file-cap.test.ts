import {expect, it} from "vitest";
import {fork} from "node:child_process";
import {on, once} from "node:events";
import {mkdtemp, readFile, readdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {readDiagnosticConfig} from "../../mcp-server/src/diagnostics.js";

it("counts buffered bytes that cross the actual file rotation boundary", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ags-write-rotation-"));
  const worker = process.env.AGENT_GOVERNANCE_LOG_TEST_WORKER
    ?? fileURLToPath(new URL("../../mcp-server/dist/diagnostics-worker.mjs", import.meta.url));
  const child = fork(worker, [], {
    execArgv: ["--import", new URL("./fixtures/write-rotation-boundary.mjs", import.meta.url).href],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {...process.env, AGS_WRITE_ROTATION_BOUNDARY: directory},
  });
  const messages: Array<Record<string, unknown>> = [];
  let stderr = "", phase = "ready", code: number | null = null;
  let files: Array<{name: string; bytes: number; rawBase64: string}> = [];
  child.on("message", message => messages.push(message as Record<string, unknown>));
  child.stderr!.on("data", chunk => {stderr += String(chunk);});
  const exited = once(child, "exit");
  const evidence = () => JSON.stringify({phase, code, exitCode: child.exitCode, signal: child.signalCode, worker, messages, stderr, files});
  async function received(predicate: (message: Record<string, unknown>) => boolean, deadlineMs = 1000): Promise<Record<string, unknown>> {
    const existing = messages.find(predicate);
    if (existing) return existing;
    for await (const [message] of on(child, "message", {signal: AbortSignal.timeout(deadlineMs)})) {
      if (predicate(message as Record<string, unknown>)) return message as Record<string, unknown>;
    }
    throw new Error("WRITE_ROTATION_FIXTURE_MESSAGE_MISSING");
  }
  const probe = (event: string, sequence?: number) => (message: Record<string, unknown>) =>
    message.fixture === "write-rotation-boundary" && message.event === event
      && (sequence === undefined || (Array.isArray(message.sequences) && message.sequences.includes(sequence)));
  async function snapshot() {
    files = await Promise.all((await readdir(directory)).filter(name => name.endsWith(".log")).map(async name => {
      const raw = await readFile(path.join(directory, name));
      return {name, bytes: raw.length, rawBase64: raw.toString("base64")};
    }));
  }
  try {
    child.send({config: readDiagnosticConfig(JSON.stringify({level: "TRACE", destination: "file",
      file: path.join(directory, "safe"), rotationBytes: 1024, rotationIntervalMs: 1000, flushDeadlineMs: 1000})), instance: "fixture"});
    await received(message => message.ready === true, 3000);
    const send = (id: number, pad: string) => child.send({id, category: "request", level: "INFO",
      fields: {event: "request_end", outcome: "success", fixtureSequence: id, pad}});
    phase = "first-write-held";
    send(1, "");
    const first = await received(probe("admitted", 1));
    await received(probe("write-held", 1));
    const firstBytes = Number(first.bytes);
    expect(firstBytes, evidence()).toBeLessThanOrEqual(324);
    phase = "second-buffered-before-flush";
    send(2, "x".repeat(700 - firstBytes));
    const second = await received(probe("admitted", 2));
    expect(second.bytes, evidence()).toBe(700);
    await received(probe("rotation-flush-requested"), 3000);
    phase = "write-released-and-rotated";
    await writeFile(path.join(directory, "release-write"), "1", "utf8");
    await received(probe("write-released", 1));
    await received(message => probe("reopen-returned")(message) && message.explicitFile === true);
    await received(probe("sink-ready"));
    await received(probe("write-complete", 2));
    phase = "third-record-after-ready";
    send(3, "x".repeat(700 - firstBytes));
    for (const id of [1, 2, 3]) await received(message => message.ack === id);
    phase = "close";
    child.send({close: true});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      [code] = await Promise.race([exited, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("WRITE_ROTATION_FIXTURE_CLOSE_TIMEOUT")), 1000);
      })]);
    } finally {clearTimeout(timer);}
    await snapshot();
    phase = "file-cap-oracle";
    expect(code, evidence()).toBe(0);
    expect(messages.some(message => message.flushed === true), evidence()).toBe(true);
    expect(messages.filter(probe("fragment-not-complete-json")), evidence()).toHaveLength(0);
    const writes = messages.filter(probe("write-complete"));
    expect(writes.every(message => message.error === null && message.written === message.bytes), evidence()).toBe(true);
    expect(messages.filter(message => probe("reopen-returned")(message) && message.explicitFile === true), evidence()).toHaveLength(1);
    const third = messages.find(probe("admitted", 3));
    if (third) expect(third.bytes, evidence()).toBe(700);
    else expect(messages.reduce((sum, message) => sum + Number(message.droppedBytes ?? 0), 0), evidence()).toBe(700);
    expect(files.every(file => file.bytes <= 1024), evidence()).toBe(true);
    const rows = files.flatMap(file => Buffer.from(file.rawBase64, "base64").toString("utf8").split("\n").filter(Boolean).map(row => JSON.parse(row)));
    expect(rows.filter(row => row.fixtureSequence === 1), evidence()).toHaveLength(1);
    expect(rows.filter(row => row.fixtureSequence === 2), evidence()).toHaveLength(1);
    const dropped = messages.reduce((sum, message) => sum + Number(message.droppedRecords ?? 0), 0);
    expect(rows.length + dropped, evidence()).toBe(3);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await snapshot();
    await writeFile(path.join(directory, "result.json"), evidence(), "utf8");
    if (process.env.AGENT_GOVERNANCE_LOG_TEST_EVIDENCE) await writeFile(
      path.join(process.env.AGENT_GOVERNANCE_LOG_TEST_EVIDENCE, "worker-file-cap-result.json"), evidence(), "utf8");
  }
}, 15000);
