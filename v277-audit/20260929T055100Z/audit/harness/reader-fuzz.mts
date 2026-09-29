// Audit fuzz: the candidate sessionMessageLineReader against the 9e76a07b per-chunk string reader, on random lines with
// valid and invalid UTF-8, random chunkings (always including a cut at 16384), and optional bytes after the newline.
// Usage: node --import tsx reader-fuzz.mts <candidate repo> <iterations>
import path from "node:path";
import { pathToFileURL } from "node:url";
const [repo, iterations] = process.argv.slice(2);
const { sessionMessageLineReader } = await import(pathToFileURL(path.join(repo!, "mcp-server/src/session-message-protocol.ts")).href);
let seed = 20260929; const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const int = (n: number) => Math.floor(rand() * n);
const LIMIT = 32768;
const pieces = [Buffer.from("a"), Buffer.from("한"), Buffer.from("😀"), Buffer.from("é"), Buffer.from([0xff]), Buffer.from([0xe0, 0x80]),
  Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xf0, 0x9f, 0x98]), Buffer.from([0x80]), Buffer.from([0xf4, 0x90, 0x80, 0x80]), Buffer.from([0xc3])];
function oldReader(limit: number) { let buffer = ""; return (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  if (Buffer.byteLength(buffer, "utf8") > limit) throw new RangeError("over");
  const newline = buffer.indexOf("\n"); if (newline < 0) return null;
  const line = buffer.slice(0, newline); buffer = ""; return line; }; }
function run(read: (c: Buffer) => string | null, chunks: Buffer[]) {
  try { let line: string | null = null; for (const c of chunks) { line = read(c); if (line !== null) return { kind: "line", line }; } return { kind: "wait" }; }
  catch { return { kind: "over" }; } }
const stats = { cases: 0, invalidCases: 0, newMismatchCanonical: 0, newWrongLimitDecision: 0, newStricterThanOld: 0, oldFalseOver: 0, oldCorrupted: 0,
  sameWhenValidAndCharAligned: 0, differWhenValidAndCharAligned: 0 };
for (let i = 0; i < Number(iterations); i += 1) {
  const invalid = rand() < 0.5; const parts: Buffer[] = []; let size = 0;
  const target = LIMIT - 200 + int(400);
  while (size < target) { const p = invalid ? pieces[int(pieces.length)]! : pieces[int(4)]!; parts.push(p); size += p.length; }
  const line = Buffer.concat(parts).subarray(0, target - 1);
  const trailing = rand() < 0.3 ? Buffer.from("extra bytes after the newline") : Buffer.alloc(0);
  const wire = Buffer.concat([line, Buffer.from("\n"), trailing]);
  const cuts = new Set([16384, ...Array.from({ length: int(4) }, () => 1 + int(wire.length - 1))]);
  const sorted = [...cuts].filter((c) => c > 0 && c < wire.length).sort((a, b) => a - b);
  const chunks: Buffer[] = []; let prev = 0; for (const c of sorted) { chunks.push(wire.subarray(prev, c)); prev = c; } chunks.push(wire.subarray(prev));
  const canonical = line.toString("utf8");
  const n = run(sessionMessageLineReader(LIMIT), chunks); const o = run(oldReader(LIMIT), chunks);
  stats.cases += 1; if (invalid) stats.invalidCases += 1;
  const shouldAccept = line.length + 1 <= LIMIT;
  if ((n.kind === "line") !== shouldAccept) stats.newWrongLimitDecision += 1;
  if (n.kind === "line" && n.line !== canonical) stats.newMismatchCanonical += 1;
  if (n.kind === "over" && o.kind === "line") stats.newStricterThanOld += 1;
  if (shouldAccept && o.kind === "over") stats.oldFalseOver += 1;
  if (o.kind === "line" && o.line !== canonical) stats.oldCorrupted += 1;
  const aligned = !invalid && sorted.every((c) => (wire[c]! & 0xc0) !== 0x80);
  if (aligned && trailing.length === 0) { if (JSON.stringify(n) === JSON.stringify(o)) stats.sameWhenValidAndCharAligned += 1; else stats.differWhenValidAndCharAligned += 1; }
}
console.log(JSON.stringify(stats));
