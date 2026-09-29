import { randomUUID } from "node:crypto";
import { SESSION_MESSAGE_PROTOCOL } from "../../../mcp-server/src/session-message-protocol.js";

type Identity = { host: string; sessionId: string };
// Node TLS hands the reader plaintext in pieces of at most this many bytes, so a long line arrives split here.
export const TLS_CHUNK = 16384;

/** How many bytes of the multi-byte character that covers byte `at - 1` lie before `at`; 0 when a character starts at `at`. */
export function headBytes(bytes: Buffer, at: number): number {
  let start = at - 1;
  while ((bytes[start]! & 0xc0) === 0x80) start -= 1;
  const length = bytes[start]! >= 0xf0 ? 4 : bytes[start]! >= 0xe0 ? 3 : bytes[start]! >= 0xc0 ? 2 : 1;
  return start + length > at ? at - start : 0;
}

/** The claim answer a broker sends for these bodies; IDs and timestamps have fixed lengths, so only bytes count. */
export function claimLine(sender: Identity, recipient: Identity, bodies: string[]): Buffer {
  const stamp = new Date(0).toISOString();
  const messages = bodies.map((body) => ({ messageId: randomUUID(), sender, recipient, body, createdAt: stamp, expiresAt: stamp,
    deliveryAttempt: 1, firstDeliveredAt: stamp }));
  return Buffer.from(`${JSON.stringify({ ok: true, data: { messages } })}\n`);
}

/**
 * Nine Korean bodies whose claim answer is `total` bytes with its newline and has `head` bytes of a character before byte
 * 16384. The first eight are the same, so the order of messages queued in one millisecond cannot move the split.
 */
export function straddlingClaim(sender: Identity, recipient: Identity, total: number, head: number): string[] {
  for (let shift = 0; shift < 3; shift += 1) {
    const bodies = Array.from({ length: 9 }, () => `${"a".repeat(shift)}${"한".repeat(1100)}`);
    bodies[8] += "z".repeat(total - claimLine(sender, recipient, bodies).length);
    if (headBytes(claimLine(sender, recipient, bodies), TLS_CHUNK) === head) return bodies;
  }
  throw new Error("No layout puts the split there.");
}

/** A ping payload whose request line is `total` bytes with its newline and has `head` bytes of a character before byte 16384. */
export function straddlingPing(token: string, total: number, head: number): { pad: string } {
  const line = (payload: { pad: string }) => Buffer.from(`${JSON.stringify({ protocolVersion: SESSION_MESSAGE_PROTOCOL, token, operation: "ping", payload })}\n`);
  for (let shift = 0; shift < 3; shift += 1) {
    const payload = { pad: `${"a".repeat(shift)}${"한".repeat(10_000)}` };
    payload.pad += "z".repeat(total - line(payload).length);
    if (headBytes(line(payload), TLS_CHUNK) === head) return payload;
  }
  throw new Error("No layout puts the split there.");
}
