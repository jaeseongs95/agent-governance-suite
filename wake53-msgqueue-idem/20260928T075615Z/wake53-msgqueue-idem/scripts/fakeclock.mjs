// Time fixture preloaded via NODE_OPTIONS=--import into the broker process only.
// If FAKE_CLOCK_FILE contains an integer, Date.now() returns it; otherwise real time.
import { readFileSync } from "node:fs";
const file = process.env.FAKE_CLOCK_FILE;
if (file) {
  const realNow = Date.now.bind(Date);
  Date.now = () => { try { const v = readFileSync(file, "utf8").trim(); if (/^\d+$/.test(v)) return Number(v); } catch {} return realNow(); };
}
