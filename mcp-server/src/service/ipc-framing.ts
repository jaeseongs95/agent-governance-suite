import { producerFailure } from "../failure-diagnostics.js";

/**
 * Line framing of the service IPC (docs/ags31-dbms-service-design.md 4.3): one UTF-8 JSON value per line, the same
 * framing as MCP stdio. A line longer than the limit is a protocol failure, never truncated or split.
 */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;
const NEWLINE = 0x0a;

export class LineDecoder {
  private chunks: Buffer[] = [];
  private pendingBytes = 0;

  constructor(private readonly maxLineBytes = MAX_LINE_BYTES) {}

  /** Returns every complete line in arrival order. Only the new chunk is scanned, so a long line is not rescanned. */
  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let start = 0;
    let index = chunk.indexOf(NEWLINE, start);
    while (index >= 0) {
      const part = chunk.subarray(start, index);
      if (this.pendingBytes + part.length > this.maxLineBytes) throw lineTooLong();
      const line = this.chunks.length === 0 ? part : Buffer.concat([...this.chunks, part]);
      this.chunks = [];
      this.pendingBytes = 0;
      // A CR before LF is accepted the way MCP stdio readers accept it.
      lines.push(line.toString("utf8", 0, line.length > 0 && line[line.length - 1] === 0x0d ? line.length - 1 : line.length));
      start = index + 1;
      index = chunk.indexOf(NEWLINE, start);
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      if (this.pendingBytes + rest.length > this.maxLineBytes) throw lineTooLong();
      this.chunks.push(rest);
      this.pendingBytes += rest.length;
    }
    return lines;
  }

  /** Bytes received after the last complete line; the caller takes them over with the stream (role "mcp"). */
  rest(): Buffer {
    const rest = Buffer.concat(this.chunks);
    this.chunks = [];
    this.pendingBytes = 0;
    return rest;
  }
}

function lineTooLong(): Error {
  return producerFailure("SERVICE_LINE_TOO_LONG", "An IPC line exceeds the line limit.");
}

export function encodeLine(message: unknown, maxLineBytes = MAX_LINE_BYTES): Buffer {
  const line = Buffer.from(JSON.stringify(message) + "\n", "utf8");
  if (line.length - 1 > maxLineBytes) throw lineTooLong();
  return line;
}

/** Parses one line as a JSON object; anything else is a protocol failure with a fixed reason. */
export function parseMessage(line: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(line); }
  catch { throw producerFailure("SERVICE_PROTOCOL_ERROR", "An IPC line is not JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw producerFailure("SERVICE_PROTOCOL_ERROR", "An IPC line is not a JSON object.");
  }
  return value as Record<string, unknown>;
}
