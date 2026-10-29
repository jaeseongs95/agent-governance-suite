import fs from "node:fs";
import path from "node:path";
import {EventEmitter} from "node:events";
import {syncBuiltinESMExports} from "node:module";
import {setInterval, clearInterval} from "node:timers";

const directory = process.env.AGS_WRITE_ROTATION_BOUNDARY;
if (directory) {
  const report = fields => process.send?.({fixture: "write-rotation-boundary", ...fields});
  const matches = file => typeof file === "string" && file.startsWith(path.join(directory, "safe-fixture."));
  const descriptors = new Map();
  let generation = 0, heldWrite = false, secondAdmitted = false, pendingFlush;
  const sequences = line => {
    try {return String(line).split("\n").filter(Boolean).map(row => JSON.parse(row).fixtureSequence);}
    catch {
      // 부분 쓰기의 JSON 조각은 판별 전제 실패다. 원 fs.write와 callback은 그대로 통과시킨다.
      report({event: "fragment-not-complete-json", bytes: Buffer.byteLength(String(line))});
      return [];
    }
  };
  const open = fs.open, write = fs.write, emit = EventEmitter.prototype.emit;
  fs.open = function (...args) {
    const file = args[0], callback = args.at(-1);
    if (matches(file) && typeof callback === "function") {
      args[args.length - 1] = function (...result) {
        if (!result[0]) descriptors.set(result[1], {file: path.basename(file), generation: ++generation});
        return callback.apply(this, result);
      };
    }
    return open.apply(this, args);
  };
  fs.write = function (...args) {
    const descriptor = descriptors.get(args[0]), callback = args.at(-1);
    if (descriptor && typeof callback === "function") {
      const data = Buffer.isBuffer(args[1]) ? args[1] : Buffer.from(args[1], "utf8");
      const raw = typeof args[2] === "number" && typeof args[3] === "number" ? data.subarray(args[2], args[2] + args[3]) : data;
      const observation = {fd: args[0], ...descriptor, sequences: sequences(raw.toString("utf8")), bytes: raw.length};
      args[args.length - 1] = function (...result) {
        report({event: "write-complete", ...observation, error: result[0]?.code ?? null, written: result[1]});
        if (!heldWrite && !result[0] && result[1] === raw.length) {
          heldWrite = true;
          report({event: "write-held", ...observation});
          const release = callback.bind(this, ...result);
          const timer = setInterval(() => {
            if (!fs.existsSync(path.join(directory, "release-write"))) return;
            clearInterval(timer);
            release();
            report({event: "write-released", ...observation});
          }, 5);
          timer.unref();
          return;
        }
        return callback.apply(this, result);
      };
    }
    return write.apply(this, args);
  };
  EventEmitter.prototype.emit = function (event, ...args) {
    if (event === "ready" && matches(this.file)) {
      EventEmitter.prototype.emit = emit;
      const sinkWrite = this.write, sinkReopen = this.reopen, sinkFlush = this.flush, sinkEmit = this.emit;
      this.write = function (line) {
        const result = sinkWrite.call(this, line);
        const sequence = sequences(line);
        report({event: "admitted", sequences: sequence, bytes: Buffer.byteLength(line)});
        if (sequence.includes(2)) {
          secondAdmitted = true;
          const flush = pendingFlush;
          pendingFlush = undefined;
          flush?.();
        }
        return result;
      };
      this.flush = function (...parameters) {
        const invoke = () => {
          if (typeof parameters[0] === "function") report({event: "rotation-flush-requested"});
          return sinkFlush.apply(this, parameters);
        };
        // B를 먼저 승인하는 유효한 경합 순서를 고정한다. 제품 기록이나 원 I/O 결과는 보관·변조하지 않는다.
        if (!secondAdmitted && typeof parameters[0] === "function") {
          if (pendingFlush) throw new Error("WRITE_ROTATION_FIXTURE_FLUSH_ALREADY_HELD");
          pendingFlush = invoke;
          report({event: "flush-held-for-second-record"});
          return;
        }
        return invoke();
      };
      this.reopen = function (...parameters) {
        const result = sinkReopen.apply(this, parameters);
        report({event: "reopen-returned", explicitFile: parameters[0] !== undefined, file: path.basename(this.file)});
        return result;
      };
      this.emit = function (name, ...parameters) {
        const result = sinkEmit.call(this, name, ...parameters);
        if (name === "ready") report({event: "sink-ready", file: path.basename(this.file)});
        return result;
      };
    }
    return emit.call(this, event, ...args);
  };
  syncBuiltinESMExports();
}
