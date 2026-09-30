import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runSessionMessageCli } from "../../mcp-server/src/session-message-cli.js";
import { BrokerRequestRejected, requestSessionMessageOnce, waitForSessionMessageBrokerReady } from "../../mcp-server/src/session-message-client.js";
import {
  SESSION_MESSAGE_MAX_REQUEST_BYTES, SESSION_MESSAGE_MAX_RESPONSE_BYTES, SESSION_MESSAGE_PROTOCOL, sessionMessageLineReader,
} from "../../mcp-server/src/session-message-protocol.js";
import { SessionMessageStore, type SessionMessage } from "../../mcp-server/src/session-message-store.js";
import { headBytes, straddlingClaim, straddlingPing, TLS_CHUNK } from "./fixtures/utf8-layout.js";

const sourceBroker = fileURLToPath(new URL("../../mcp-server/src/session-message-broker.ts", import.meta.url));
const paddedClaim = pathToFileURL(fileURLToPath(new URL("./fixtures/padded-claim.mjs", import.meta.url))).href;
const sender = { host: "portable", sessionId: "sender" };
const target = { host: "portable", sessionId: "recipient" };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

function feed(limit: number, ...chunks: Buffer[]): string | null {
  const read = sessionMessageLineReader(limit);
  let line: string | null = null;
  for (const chunk of chunks) line = read(chunk);
  return line;
}
const splitAt = (text: string, at: number) => { const bytes = Buffer.from(text); return [bytes.subarray(0, at), bytes.subarray(at)]; };

it.each([
  ["a 3-byte Korean character split 1|2", "한", 1],
  ["a 3-byte Korean character split 2|1", "한", 2],
  ["a 4-byte emoji split 1|3", "😀", 1],
  ["a 4-byte emoji split 2|2", "😀", 2],
  ["a 4-byte emoji split 3|1", "😀", 3],
])("decodes %s at byte 16384 as the original text", (_name, character, head) => {
  const text = `${"a".repeat(TLS_CHUNK - head)}${character}${"b".repeat(100)}`;
  const [first, second] = splitAt(`${text}\n`, TLS_CHUNK);
  expect(headBytes(Buffer.from(text), TLS_CHUNK)).toBe(head);
  expect(feed(SESSION_MESSAGE_MAX_RESPONSE_BYTES, first!, second!)).toBe(text);
});

it("counts the line with its newline in raw bytes: exactly the limit is accepted, one byte more is rejected", () => {
  // 16 bytes with the newline, arriving with its Korean character split 1|2.
  const exact = `${"a".repeat(12)}한\n`;
  expect(feed(16, ...splitAt(exact, 13))).toBe(`${"a".repeat(12)}한`);
  expect(() => feed(16, ...splitAt(`a${exact}`, 14))).toThrow();
  // Without a newline, the limit itself still waits for more; one byte past it is rejected at once.
  expect(feed(16, Buffer.from("a".repeat(16)))).toBeNull();
  expect(() => feed(16, Buffer.from("a".repeat(17)))).toThrow();
  // A chunk that ends inside a character counts its raw bytes only (decoded, the partial character would count three).
  const [partial] = splitAt(`${"a".repeat(14)}한`, 16);
  expect(feed(16, partial!)).toBeNull();
});

async function launch(): Promise<string> {
  const state = await mkdtemp(path.join(tmpdir(), "ags-utf8-framing-"));
  cleanup.push(() => rm(state, { recursive: true, force: true, maxRetries: 10 }));
  const child = spawn(process.execPath, ["--import", "tsx", "--import", paddedClaim, sourceBroker, "--state-directory", state],
    { windowsHide: true, stdio: "ignore" });
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
  });
  await waitForSessionMessageBrokerReady(state, child, 5000);
  return state;
}

function queue(state: string, recipient: typeof target, bodies: string[]): void {
  const store = new SessionMessageStore(path.join(state, "session-messages.sqlite3"));
  try {
    const base = Date.now();
    bodies.forEach((body, index) => store.submitPrepared(sender, store.prepare({ sender, target: recipient, body }, base + index).messageId, base + index));
  } finally { store.close(); }
}

it.each([1, 2])("accepts a real claim answer of exactly the response limit with a Korean character split %i|rest at the TLS chunk, and rejects one byte more", async (head) => {
  const state = await launch();
  const bodies = straddlingClaim(sender, target, SESSION_MESSAGE_MAX_RESPONSE_BYTES, head);
  queue(state, target, bodies);
  const data = await requestSessionMessageOnce<{ messages: SessionMessage[] }>("claim", { target }, state);
  expect(data.messages.map((message) => message.body)).toEqual(bodies);
  const sent = Buffer.from(`${JSON.stringify({ ok: true, data })}\n`);
  expect(sent.length).toBe(SESSION_MESSAGE_MAX_RESPONSE_BYTES);
  expect(headBytes(sent, TLS_CHUNK)).toBe(head);

  const over = { host: "portable", sessionId: "over-by-one" };
  queue(state, over, straddlingClaim(sender, over, SESSION_MESSAGE_MAX_RESPONSE_BYTES, head));
  const error = await requestSessionMessageOnce("claim", { target: over }, state).then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(BrokerRequestRejected);
  expect((error as Error).message).toBe("The broker response exceeded its limit.");
}, 30_000);

it.each([1, 2])("accepts a request of exactly the request limit with a Korean character split %i|rest at the TLS chunk, and rejects one byte more", async (head) => {
  const state = await launch();
  const token = (await readFile(path.join(state, "broker.token"), "utf8")).trim();
  const exact = straddlingPing(token, SESSION_MESSAGE_MAX_REQUEST_BYTES, head);
  await expect(requestSessionMessageOnce("ping", exact, state)).resolves.toMatchObject({ protocolVersion: SESSION_MESSAGE_PROTOCOL });
  const over = { pad: `${exact.pad}z` };
  const error = await requestSessionMessageOnce("ping", over, state).then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(BrokerRequestRejected);
  expect((error as Error).message).toBe("Request exceeds the broker limit.");
}, 30_000);

it("delivers twelve batches of Korean messages through the CLI claim path byte for byte", async () => {
  const state = await launch();
  const cli = async (operation: string, payload: Record<string, unknown>) => (await runSessionMessageCli(JSON.stringify({ operation, payload }), state)).data;
  const broken: number[] = [];
  let replacementCharacters = 0;
  for (let round = 0; round < 12; round += 1) {
    // Eight bodies of 3.4-3.8 KB fill one default claim (up to 10 messages, 32 KB) past the first TLS chunk; the length
    // and leading ASCII of each round move where that chunk boundary falls, mostly inside a Korean character.
    const bodies = Array.from({ length: 8 }, (_, index) => `${"a".repeat(round % 3)}${index}:${"세션 메시지 한글 본문 ".repeat(110 + round)}`);
    queue(state, target, bodies);
    const { messages } = await cli("claim", { target }) as { messages: SessionMessage[] };
    const received = messages.map((message) => message.body);
    replacementCharacters += received.join("").split("�").length - 1;
    if (received.length !== bodies.length || received.some((body, index) => !Buffer.from(body).equals(Buffer.from(bodies[index]!)))) broken.push(round);
    await cli("acknowledge", { target, messageIds: messages.map((message) => message.messageId) });
  }
  expect({ broken, replacementCharacters }).toEqual({ broken: [], replacementCharacters: 0 });
}, 60_000);

it("hands a Korean claim answer one byte under the limit to the CLI instead of retrying into an empty 120 s lease", async () => {
  const state = await launch();
  const bodies = straddlingClaim(sender, target, SESSION_MESSAGE_MAX_RESPONSE_BYTES - 1, 1);
  queue(state, target, bodies);
  const { messages } = (await runSessionMessageCli(JSON.stringify({ operation: "claim", payload: { target } }), state)).data as { messages: SessionMessage[] };
  const store = new SessionMessageStore(path.join(state, "session-messages.sqlite3"));
  const leased = (() => {
    try {
      return store.database.prepare("SELECT delivery_attempts, claimed_at, claim_until FROM messages WHERE acknowledged_at IS NULL AND claim_until IS NOT NULL")
        .all() as Array<{ delivery_attempts: number; claimed_at: string; claim_until: string }>;
    } finally { store.close(); }
  })();
  // All nine rows are leased once for the first 120 s; the caller must be the one holding them.
  expect({
    returned: messages.length,
    intact: messages.map((message) => message.body).join("\n") === bodies.join("\n"),
    leased: leased.length,
    attempts: [...new Set(leased.map((row) => row.delivery_attempts))],
    leaseMs: [...new Set(leased.map((row) => Date.parse(row.claim_until) - Date.parse(row.claimed_at)))],
  }).toEqual({ returned: 9, intact: true, leased: 9, attempts: [1], leaseMs: [120_000] });
}, 30_000);
