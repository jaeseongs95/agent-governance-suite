import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { setTimeout as delay } from "node:timers/promises";
import type { PeerWaitDecision } from "./peer-wait-policy.js";
import { msg, render, resolveHostLocale, ROOT_LOCALE, type MessageRef, type SupportedLocale } from "./i18n.js";
import { sessionMessageRequest } from "./session-message-client.js";
import { SessionMessageError } from "./session-message-protocol.js";

const OPERATIONS = new Set(["prepare", "send", "claim", "acknowledge", "status", "pending", "wait"]);

/** Vendor-neutral stdin/stdout adapter. Secrets and message bodies never appear in process arguments. */
export async function runSessionMessageCli(raw: string, stateDirectory?: string): Promise<Record<string, unknown>> {
  const request = JSON.parse(raw) as { operation?: unknown; payload?: unknown };
  if (typeof request.operation !== "string" || !OPERATIONS.has(request.operation)) throw new SessionMessageError(msg("services.sessionMessage.cli.unsupportedOperation", {}));
  if (!request.payload || typeof request.payload !== "object" || Array.isArray(request.payload)) throw new SessionMessageError(msg("services.sessionMessage.cli.payloadNotObject", {}));
  const payload = request.payload as Record<string, unknown>;
  if (request.operation === "wait") {
    const timeoutMs = payload.timeoutMs === undefined ? 0 : payload.timeoutMs;
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 3_600_000) throw new SessionMessageError(msg("services.sessionMessage.peerWait.timeoutRange", {}));
    const decision = await sessionMessageRequest<PeerWaitDecision>("peer-wait", { sender: payload.sender, targets: payload.targets, timeoutMs }, stateDirectory);
    // This adapter owns its delay boundary. Unknown resume permits one short wait,
    // never a background poller or an instruction to stop permanently.
    const waitedMs = decision.action === "bounded" ? Math.min(timeoutMs, 1000) : 0;
    let snapshot = decision;
    if (waitedMs > 0) {
      await delay(waitedMs);
      snapshot = await sessionMessageRequest<PeerWaitDecision>("peer-wait", { sender: payload.sender, targets: payload.targets, timeoutMs: 0 }, stateDirectory);
    }
    return { protocolVersion: "1.0.0", ok: true, data: { decision, snapshot, waitedMs, next: decision.resume === "observed" ? "peer-resume" : "bounded-query-or-next-user-turn" } };
  }
  const data = await sessionMessageRequest<unknown>(request.operation, payload, stateDirectory);
  return { protocolVersion: "1.0.0", ok: true, data };
}

/** The CLI's error text in the host locale, with the key and params that let a reader render it again. */
function shownError(ref: MessageRef, locale: SupportedLocale): { error: string; messageKey: string; params: Readonly<Record<string, unknown>> } {
  return { error: render(ref, locale), messageKey: ref.key, params: ref.params as Readonly<Record<string, unknown>> };
}

export function formatSessionMessageStdinReadError(error: unknown, locale: SupportedLocale = ROOT_LOCALE): {
  protocolVersion: "1.0.0";
  ok: false;
  errorCode: string;
  error: string;
  messageKey: string;
  params: Readonly<Record<string, unknown>>;
} {
  const rawCode = (error as { code?: unknown } | null)?.code;
  const errorCode = typeof rawCode === "string" && /^[A-Z0-9_]{1,32}$/u.test(rawCode) ? rawCode : "STDIN_READ_ERROR";
  // The reason is the operating system's own text, shown as it is.
  const ref = error instanceof Error && error.message.length > 0
    ? msg("services.sessionMessage.cli.stdinReadFailed", { errorCode, reason: error.message })
    : msg("services.sessionMessage.cli.stdinReadFailedUnknown", { errorCode });
  return { protocolVersion: "1.0.0", ok: false, errorCode, ...shownError(ref, locale) };
}

/** A failure the CLI prints: catalog messages in the host locale; another error's own text as it is. */
export function formatSessionMessageCliFailure(error: unknown, locale: SupportedLocale = ROOT_LOCALE): Record<string, unknown> {
  const ref = error instanceof SessionMessageError ? error.ref : error instanceof Error ? null : msg("services.sessionMessage.cli.requestFailed", {});
  return { protocolVersion: "1.0.0", ok: false, ...(ref ? shownError(ref, locale) : { error: (error as Error).message }) };
}

export async function executeSessionMessageCliFromStdin(
  readStdin: () => string = () => readFileSync(0, "utf8"),
  stateDirectory?: string,
  locale: SupportedLocale = ROOT_LOCALE,
): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = readStdin();
  } catch (error: unknown) {
    return formatSessionMessageStdinReadError(error, locale);
  }
  return runSessionMessageCli(raw, stateDirectory);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const { locale } = resolveHostLocale();
  void executeSessionMessageCliFromStdin(undefined, undefined, locale).then(
    (output) => {
      process.stdout.write(`${JSON.stringify(output)}\n`);
      if (output.ok === false) process.exitCode = 1;
    },
    (error: unknown) => {
      process.stdout.write(`${JSON.stringify(formatSessionMessageCliFailure(error, locale))}\n`);
      process.exitCode = 1;
    },
  );
}
