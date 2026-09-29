// Audit microbenchmark: reader CPU for one 32768-byte line delivered in chunks of 16384, 1024, 64 and 1 bytes (new vs 9e76a07b).
import path from "node:path";
import { pathToFileURL } from "node:url";
const { sessionMessageLineReader } = await import(pathToFileURL(path.join(process.argv[2]!, "mcp-server/src/session-message-protocol.ts")).href);
function oldReader(limit: number) { let buffer = ""; return (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  if (Buffer.byteLength(buffer, "utf8") > limit) throw new RangeError("over");
  const newline = buffer.indexOf("\n"); if (newline < 0) return null;
  const line = buffer.slice(0, newline); buffer = ""; return line; }; }
const wire = Buffer.from(`${"한".repeat(10922)}a\n`); // 32768 bytes
const out: Record<string, unknown> = { lineBytes: wire.length };
for (const size of [16384, 1024, 64, 1]) {
  const chunks: Buffer[] = []; for (let i = 0; i < wire.length; i += size) chunks.push(wire.subarray(i, i + size));
  for (const [name, make] of [["new", () => sessionMessageLineReader(32768)], ["old", () => oldReader(32768)]] as const) {
    const reps = size === 1 ? 5 : 50; let result: unknown = null; const t = performance.now();
    for (let r = 0; r < reps; r += 1) { const read = make(); for (const c of chunks) { try { result = read(c); } catch { result = "over"; break; } } }
    out[`${name}-chunk${size}-msPerLine`] = +((performance.now() - t) / reps).toFixed(3);
    out[`${name}-chunk${size}-ok`] = typeof result === "string" && result.length === 10923;
  }
}
console.log(JSON.stringify(out));
