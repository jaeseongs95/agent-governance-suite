import {expect, it} from "vitest";
import {fork} from "node:child_process";
import {on, once} from "node:events";
import {mkdtemp, readFile, readdir, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {readDiagnosticConfig} from "../../mcp-server/src/diagnostics.js";

const workerFile = fileURLToPath(new URL("../../mcp-server/dist/diagnostics-worker.mjs", import.meta.url));
const gateFile = new URL("./fixtures/rotation-open-gate.mjs", import.meta.url).href;

it.each(["steady", "rotating"] as const)("preserves admitted request outcomes across the actual worker %s boundary", async mode => {
  const directory = await mkdtemp(path.join(tmpdir(), "ags-worker-rotation-"));
  // 실제 번들에 파일 열기 callback gate만 선행 로드한다. 제품 소스는 바꾸지 않는다.
  const child = fork(process.env.AGENT_GOVERNANCE_LOG_TEST_WORKER ?? workerFile, [], {
    execArgv: ["--import", gateFile], stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {...process.env, AGS_ROTATION_OPEN_GATE: mode === "rotating" ? directory : ""},
  });
  const messages: Array<Record<string, unknown>> = [];
  let stderr = "";
  child.stderr!.on("data", chunk => {stderr += String(chunk);});
  child.on("message", message => messages.push(message as Record<string, unknown>));
  async function received(predicate: (message: Record<string, unknown>) => boolean, deadlineMs = 1000) {
    const existing = messages.find(predicate);
    if (existing) return existing;
    for await (const [message] of on(child, "message", {signal: AbortSignal.timeout(deadlineMs)})) {
      if (predicate(message as Record<string, unknown>)) return message;
    }
    throw new Error("WORKER_FIXTURE_MESSAGE_MISSING");
  }
  const exited = once(child, "exit");
  try {
    child.send({config: readDiagnosticConfig(JSON.stringify({level: "TRACE", destination: "file",
      file: path.join(directory, "safe"), rotationIntervalMs: 1000, flushDeadlineMs: 1000})), instance: "fixture"});
    await received(message => message.ready === true, 3000);
    const sendOutcome = async (id: number, outcome: string) => {
      child.send({id, category: "request", level: "INFO", fields: {event: "request_end", outcome, fixtureSequence: id}});
      await received(message => message.ack === id);
    };
    await sendOutcome(1, "success");
    if (mode === "rotating") {
      const held = await received(message => message.fixture === "rotation-open-held", 3000);
      expect(held).toMatchObject({error: null});
    }
    await sendOutcome(2, "rejected");
    if (mode === "rotating") {
      await writeFile(path.join(directory, "release-open"), "1", "utf8");
      await received(message => message.fixture === "rotation-open-released");
    }
    await sendOutcome(3, "thrown");
    child.send({close: true});
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let code: number | null;
    try {
      [code] = await Promise.race([exited, new Promise<never>((_resolve, reject) => {
        closeTimer = setTimeout(() => reject(new Error("WORKER_FIXTURE_CLOSE_TIMEOUT")), 1000);
      })]);
    } finally {clearTimeout(closeTimer);}
    const files = await Promise.all((await readdir(directory)).filter(name => name.endsWith(".log")).map(async name => {
      const raw = await readFile(path.join(directory, name));
      return {name, bytes: (await stat(path.join(directory, name))).size, rawBase64: raw.toString("base64")};
    }));
    const observation = {mode, code, messages, stderr, files};
    const evidence = JSON.stringify(observation);
    await writeFile(path.join(directory, "result.json"), evidence, "utf8");
    if (process.env.AGENT_GOVERNANCE_LOG_TEST_EVIDENCE) await writeFile(
      path.join(process.env.AGENT_GOVERNANCE_LOG_TEST_EVIDENCE, `worker-${mode}-result.json`), evidence, "utf8");
    expect(code, evidence).toBe(0);
    const events = files.flatMap(file => Buffer.from(file.rawBase64, "base64").toString("utf8").split(/\r?\n/)
      .filter(Boolean).map(line => JSON.parse(line))).sort((a, b) => a.fixtureSequence - b.fixtureSequence);
    if (mode === "rotating") {
      expect(messages.filter(message => message.fixture === "rotation-open-held"), evidence).toHaveLength(1);
    }
    expect(events.map(event => event.outcome), evidence).toEqual(["success", "rejected", "thrown"]);
    expect(messages.filter(message => typeof message.droppedRecords === "number"), evidence).toEqual([]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
}, 15000);
