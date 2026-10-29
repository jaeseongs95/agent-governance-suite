import pino from "pino";
import SonicBoomImport from "sonic-boom";
const SonicBoom = SonicBoomImport as unknown as typeof import("sonic-boom").SonicBoom;
// @ts-expect-error pino-roll's JavaScript package does not ship declarations.
import buildRoll from "pino-roll";
import type {DiagnosticConfig} from "./diagnostics.js";

let sink: import("sonic-boom").SonicBoom | undefined;
let loggers: Record<string, pino.Logger> = {};
let ready: Promise<void> = Promise.resolve();
let unavailable = false;
function send(message: object) {try {if (process.connected) process.send?.(message);} catch {unavailable = true;}}
process.on("message", (message: {config?: DiagnosticConfig; instance?: string; id?: number; category?: string; level?: string; fields?: object; close?: boolean}) => {
  if (message.config) {
    ready = (async () => {
      const config = message.config!;
      const options = {sync: false, maxLength: config.bufferBytes, minLength: 0, periodicFlush: 100,
        fsync: false, retryEAGAIN: () => false};
      let admittedBytes = 0, rotating = true, cleanupPending = false;
      let releaseRotation: (() => void) | undefined;
      const settleRotation = () => {releaseRotation?.(); releaseRotation = undefined;};
      if (config.destination === "file") {
        const roll = buildRoll as (options: object) => Promise<import("sonic-boom").SonicBoom>;
        sink = await roll({...options, file: `${config.file}-${message.instance}`, frequency: config.rotationIntervalMs,
          limit: {count: config.retainedFiles, removeOtherLogFiles: false}});
      } else sink = new SonicBoom({...options, fd: 2});
      sink.on("drop", (data: string) => send({droppedRecords: 1, droppedBytes: Buffer.byteLength(data)}));
      sink.on("error", () => {unavailable = true; settleRotation(); send({failed: true}); try {sink?.destroy();} catch { /* Already failed; no raw I/O exception leaves the diagnostic child. */ }});
      // The library owns filenames, flushing and retention. Admission is paused across its public reopen boundary.
      const reopen = sink.reopen.bind(sink);
      sink.reopen = (...args) => {
        if (args[0] !== undefined) {
          if (cleanupPending) throw new Error("DIAGNOSTIC_ROTATION_CLEANUP_PENDING");
          cleanupPending = true;
        }
        if (!rotating) {
          rotating = true;
          // 기존 부모 pending 상한 안에서 기다린다. ACK는 회전 뒤 처리할 때 보낸다.
          ready = new Promise<void>(resolve => {releaseRotation = resolve;});
        }
        try {reopen(...args);} catch (error) {settleRotation(); throw error;}
      };
      sink.on("cleanup-complete", () => {cleanupPending = false;});
      sink.on("ready", () => {admittedBytes = 0; rotating = false; settleRotation();});
      const opened = new Promise<void>((resolve, reject) => {sink!.once("ready", resolve); sink!.once("error", reject);});
      const writer = {write(line: string) {
        const bytes = Buffer.byteLength(line);
        if (unavailable || (config.destination === "file" && (rotating || admittedBytes + bytes > config.rotationBytes))) {
          send({droppedRecords: 1, droppedBytes: bytes}); return;
        }
        admittedBytes += bytes; sink!.write(line);
      }};
      loggers = Object.fromEntries(["lifecycle", "request", "binding", "transport"].map(category => [category, pino({
        level: "trace", base: {instance: message.instance, pid: process.ppid, category}, timestamp: pino.stdTimeFunctions.isoTime,
      }, writer)]));
      await opened;
      send({ready: true});
    })().catch(() => {unavailable = true; send({failed: true});});
    return;
  }
  void (async () => {
    // ready 통지 안에서 다음 reopen이 시작되면 최신 회전까지 기다린다.
    let observedReady: Promise<void>;
    do {observedReady = ready; await observedReady;} while (observedReady !== ready);
    if (message.close) {
      if (sink && !unavailable) {sink.once("finish", () => {if (process.connected) process.send?.({flushed: true}, () => process.exit(0)); else process.exit(0);}); sink.end();}
      else process.exit(0);
      return;
    }
    try {
      const logger = loggers[message.category ?? ""];
      const method = message.level?.toLowerCase();
      if (!unavailable && logger && method && ["trace", "debug", "info", "warn", "error", "fatal"].includes(method)) logger[method as "info"](message.fields);
      else send({droppedRecords: 1, droppedBytes: Buffer.byteLength(JSON.stringify(message.fields ?? {}))});
    } catch {unavailable = true; send({failed: true});}
    send({ack: message.id});
  })().catch(() => {unavailable = true; send({failed: true});});
});
process.on("disconnect", () => process.kill(process.pid, "SIGKILL"));
