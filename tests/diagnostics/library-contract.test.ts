import {expect, it, vi} from "vitest";
import {createRequire} from "node:module";
import {once} from "node:events";
import {mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import type {SonicBoom} from "sonic-boom";

const require = createRequire(import.meta.url);
const rollRequire = createRequire(require.resolve("pino-roll"));
const roll = require("pino-roll") as (options: object) => Promise<SonicBoom & {file: string}>;

it("pins the direct logging libraries and checks the resolved rotation sink version", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  for (const [name, version] of [["pino", "10.4.0"], ["pino-roll", "4.0.0"], ["sonic-boom", "5.0.2"]]) {
    expect(manifest.dependencies[name!]).toBe(version);
    expect(require(name! + "/package.json").version).toBe(version);
  }
  // File rotation uses pino-roll's nested sink, independently of the direct stderr sink.
  expect(rollRequire("sonic-boom/package.json").version).toBe("4.2.1");
});

it("keeps the pinned library's reopen, ready and cleanup-complete rotation contract", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ags-roll-contract-"));
  // Keep the first rotation behind listener registration, regardless of host load.
  vi.useFakeTimers({toFake: ["Date", "setTimeout", "clearTimeout"]});
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  let sink: Awaited<ReturnType<typeof roll>> | undefined;
  try {
    sink = await roll({file: path.join(directory, "event"), frequency: 100,
    limit: {count: 1, removeOtherLogFiles: false}, sync: false, minLength: 0});
    await once(sink, "ready", {signal: AbortSignal.timeout(2000)});
    const initial = sink.file;
    const events: string[] = [];
    const reopen = sink.reopen.bind(sink);
    sink.reopen = (...args) => {events.push("reopen"); reopen(...args);};
    sink.on("ready", () => events.push("ready"));
    sink.on("cleanup-complete", () => events.push("cleanup-complete"));
    const rotated = Promise.all([once(sink, "ready"), once(sink, "cleanup-complete", {signal: AbortSignal.timeout(2000)})]);
    const written = once(sink, "write", {signal: AbortSignal.timeout(2000)});
    sink.write("before-rotation\n");
    await written;
    await vi.advanceTimersByTimeAsync(100);
    await rotated;
    expect(events[0]).toBe("reopen");
    expect(events).toContain("ready");
    expect(events).toContain("cleanup-complete");
    expect(sink.file).not.toBe(initial);
    expect(await readFile(initial, "utf8")).toBe("before-rotation\n");
  } finally {
    try {
      if (sink) {
        const closed = once(sink, "close", {signal: AbortSignal.timeout(2000)});
        sink.end();
        await closed;
      }
    } finally {
      vi.useRealTimers();
    }
  }
});
