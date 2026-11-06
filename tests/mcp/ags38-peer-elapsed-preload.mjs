// TEST-only observation of real Node time. It does not replace the clock, input, budget or product entry.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";

const marker = "AGS38_PEER_ELAPSED ";
const observe = phase => fs.writeSync(2, marker + JSON.stringify({ phase, nowMs: performance.now() }) + "\n");
const read = fs.readFileSync;
fs.readFileSync = function (...args) {
  if (args[0] !== 0) return Reflect.apply(read, this, args);
  observe("stdin-enter");
  const value = Reflect.apply(read, this, args);
  observe("stdin-return");
  return value;
};
syncBuiltinESMExports();
observe("preload-ready");
