import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, get, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { AdminError, type AdminErrorCode, ADMIN_RP_ID } from "./admin-webauthn.js";
import { ADMIN_PAGE_HTML } from "./admin-page.generated.js";
import { ROLE_NAME_MAX_LENGTH } from "./admin-log.js";
import { type AdminPageState, type ContextLayerService, GLOBAL_CONTEXT_MAX_BYTES, ROLE_CONTEXT_MAX_BYTES } from "./context-layer-service.js";
import type { AdminSettingsView } from "./admin-settings.js";
import { failureCode } from "./failure-diagnostics.js";
import { writeDiagnostic } from "./hook-error-diagnostics.js";
import { hostMarksNoSubagents } from "./host-input-adapter.js";
import { readAdminPageRecord, resolveAdminPageRecordPath } from "./runtime-config.js";

/**
 * The local admin page (AGS3-T-0024): node:http on 127.0.0.1, opened as http://localhost:<port> (a WebAuthn relying
 * party ID cannot be an IP address). Viewing needs no passkey; every change is a record the user's passkey signs, and
 * the service verifies it. The checks here keep other web pages out (DNS rebinding, cross-site POST); they are not what
 * protects a change from an agent on this computer — the signature is.
 */
export const ADMIN_BODY_MAX_BYTES = 64 * 1024;
/** A JEV key value's length limit (characters). */
export const JEV_KEY_MAX_LENGTH = 4096;

export interface AdminSessionView {
  host: string;
  hostLabel: string;
  sessionId: string;
  state: "online" | "unreachable" | "ended";
  cwd: string | null;
  summary: string | null;
  /** The role line the session wrote on the board itself; grants nothing. */
  selfRole: string | null;
  lastSeenAt: string | null;
  /** The page cannot tell a main session from a subagent; the user decides (AGS3-D-0091). */
  kindUnknown?: boolean;
}

/** On a host without a subagent marker, a session that has written nothing about itself may be a subagent. */
export function sessionKindUnknown(session: { host: string; summary: string | null; role: string | null }): boolean {
  return hostMarksNoSubagents(session.host) && !session.summary && !session.role;
}

export type { AdminSettingsView };

export interface AdminPageDependencies {
  service: ContextLayerService;
  port: number;
  /** The sessions this computer's presence and board know; throws when they cannot be read. */
  listSessions: () => Promise<AdminSessionView[]>;
  /** The settings with what bounds them (environment, installation); never a secret value. */
  settings: (admin: AdminPageState) => Promise<AdminSettingsView>;
}

const STATUS: Partial<Record<AdminErrorCode, number>> = {
  ADMIN_ORIGIN_REJECTED: 403, ADMIN_KEY_NOT_REGISTERED: 403, ADMIN_KEY_UNKNOWN: 403, ADMIN_KEY_REVOKED: 403,
  ADMIN_PROPOSAL_NOT_FOUND: 404,
  ADMIN_TARGET_STALE: 409, ADMIN_ALREADY_BOOTSTRAPPED: 409, ADMIN_LAST_KEY_REVOKE_REFUSED: 409, ADMIN_LOG_REGRESSED: 409,
};

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly details: Record<string, unknown> = {}) {
    super(code);
  }
}

const COMMON_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

function send(response: ServerResponse, status: number, body: string, headers: Record<string, string>): void {
  response.writeHead(status, { ...COMMON_HEADERS, ...headers, "Content-Length": String(Buffer.byteLength(body, "utf8")) });
  response.end(body);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, JSON.stringify(value), { "Content-Type": "application/json; charset=utf-8" });
}

function page(response: ServerResponse, html: string): void {
  const nonce = randomBytes(18).toString("base64");
  send(response, 200, html.replaceAll("__CSP_NONCE__", nonce), {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; `
      + "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
}

/** The page sent to http://127.0.0.1:<port>: why it moves, then the same path on localhost. */
function moveToLocalhost(port: number, pathName: string): string {
  const target = `http://localhost:${port}${pathName.startsWith("/") ? pathName : "/"}`;
  const escaped = target.replace(/[&<>"]/g, character => `&#${character.charCodeAt(0)};`);
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta http-equiv="refresh" content="3;url=${escaped}">`
    + `<title>AGS 관리자 · localhost로 이동</title><style nonce="__CSP_NONCE__">body{font:16px/1.6 system-ui,sans-serif;margin:40px;max-width:640px}</style></head>`
    + `<body><h1>localhost 주소로 이동합니다</h1><p>패스키(WebAuthn)는 IP 주소를 쓸 수 없어, 관리자 페이지는 <code>${escaped}</code>에서만 저장할 수 있습니다. 3초 뒤 이동합니다.</p>`
    + `<p><a href="${escaped}">지금 이동</a></p></body></html>`;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const type = (request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "CONTENT_TYPE_REJECTED");
  // An oversized body is read to its end and dropped (bounded by the request timeout) so the 413 still reaches the page.
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= ADMIN_BODY_MAX_BYTES) chunks.push(chunk);
    });
    request.once("end", resolve);
    request.once("error", reject);
  });
  if (size > ADMIN_BODY_MAX_BYTES) throw new HttpError(413, "REQUEST_TOO_LARGE", { limit: ADMIN_BODY_MAX_BYTES });
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "REQUEST_INVALID", { reason: "JSON" }); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "REQUEST_INVALID", { reason: "OBJECT" });
  return parsed as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, name: string, max: number): string {
  const value = body[name];
  if (typeof value !== "string" || !value || value.length > max) throw new HttpError(400, "REQUEST_INVALID", { field: name });
  return value;
}

const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;

/** Builds the request handler; exported so tests drive it without a socket. */
export function createAdminRequestHandler(dependencies: AdminPageDependencies) {
  const { service, port } = dependencies;
  const origin = `http://localhost:${port}`;
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);

  async function state(): Promise<AdminPageState & Record<string, unknown>> {
    const admin = service.adminState();
    let sessions: AdminSessionView[] = [];
    let sessionsError: { code: string } | null = null;
    try { sessions = await dependencies.listSessions(); } catch (error) { sessionsError = { code: failureCode(error) ?? "SESSIONS_UNAVAILABLE" }; }
    const known = new Set(sessions.map(session => `${session.host}\u0000${session.sessionId}`));
    // A bound session the presence no longer knows is shown as ended, so its binding can still be seen and removed.
    for (const binding of admin.bindings) {
      if (!known.has(`${binding.host}\u0000${binding.sessionId}`)) {
        sessions.push({ host: binding.host, hostLabel: binding.host, sessionId: binding.sessionId, state: "ended", cwd: null, summary: null, selfRole: null, lastSeenAt: null });
      }
    }
    const bindings = new Map(admin.bindings.map(binding => [`${binding.host}\u0000${binding.sessionId}`, binding]));
    return {
      schemaVersion: "1.0.0", rpId: ADMIN_RP_ID, ...admin,
      globalMaxBytes: GLOBAL_CONTEXT_MAX_BYTES, roleMaxBytes: ROLE_CONTEXT_MAX_BYTES, roleNameMaxLength: ROLE_NAME_MAX_LENGTH,
      sessions: sessions.map(session => {
        const binding = bindings.get(`${session.host}\u0000${session.sessionId}`);
        return { ...session, binding: binding ? { roleId: binding.roleId, boundAt: binding.boundAt, lastUsedAt: binding.lastUsedAt, lapsed: binding.lapsed } : null };
      }),
      sessionsError,
      settings: await dependencies.settings(admin),
    };
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = (request.headers.host ?? "").toLowerCase();
    if (!allowedHosts.has(host)) throw new HttpError(403, "HOST_REJECTED");
    const url = new URL(request.url ?? "/", origin);
    const method = request.method ?? "GET";
    if (host.startsWith("127.0.0.1:")) {
      if (method === "GET" && !url.pathname.startsWith("/api/")) return page(response, moveToLocalhost(port, url.pathname));
      throw new HttpError(403, "HOST_REJECTED", { use: origin });
    }
    if (method === "GET") {
      if (url.pathname === "/") return page(response, ADMIN_PAGE_HTML);
      if (url.pathname === "/api/state") return json(response, 200, await state());
      const lookup = /^\/api\/request\/([^/]+)$/.exec(url.pathname);
      if (lookup) {
        if (!REQUEST_ID.test(lookup[1]!)) throw new HttpError(400, "REQUEST_INVALID", { field: "requestId" });
        const record = service.recordByRequest(lookup[1]!);
        return json(response, 200, { record: record ? { seq: record.seq, target: record.target, recordHash: record.recordHash, createdAt: record.createdAt } : null });
      }
      throw new HttpError(404, "NOT_FOUND");
    }
    if (method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
    // A cross-site page can POST to localhost; only this page's own origin may change anything.
    if (request.headers.origin !== origin) throw new HttpError(403, "ADMIN_ORIGIN_REJECTED");
    const site = request.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin") throw new HttpError(403, "ADMIN_ORIGIN_REJECTED", { fetchSite: String(site).slice(0, 20) });
    const body = await readJson(request);
    if (url.pathname === "/api/intent") {
      if (body.bootstrap !== undefined && typeof body.bootstrap !== "boolean") throw new HttpError(400, "REQUEST_INVALID", { field: "bootstrap" });
      if (body.baseHash !== undefined && body.baseHash !== null && (typeof body.baseHash !== "string" || body.baseHash.length > 200)) throw new HttpError(400, "REQUEST_INVALID", { field: "baseHash" });
      return json(response, 200, service.prepareIntent(body.change, body.bootstrap === true, body.baseHash as string | null | undefined));
    }
    if (url.pathname === "/api/commit") {
      const assertion = body.assertion as Record<string, unknown> | null;
      if (!assertion || typeof assertion !== "object") throw new HttpError(400, "REQUEST_INVALID", { field: "assertion" });
      const requestId = stringField(body, "requestId", 100);
      if (!REQUEST_ID.test(requestId)) throw new HttpError(400, "REQUEST_INVALID", { field: "requestId" });
      const proposalId = body.proposalId === null || body.proposalId === undefined ? null : stringField(body, "proposalId", 100);
      // A JEV key's value travels only with its signed registration; it is encrypted and never sent back.
      const secret = body.secret === null || body.secret === undefined ? null : stringField(body, "secret", JEV_KEY_MAX_LENGTH);
      if (secret !== null && /\p{Cc}/u.test(secret)) throw new HttpError(400, "REQUEST_INVALID", { field: "secret" });
      const { record, duplicate } = service.commit({
        intent: stringField(body, "intent", ADMIN_BODY_MAX_BYTES), requestId, proposalId, origin, secret,
        assertion: { credentialId: stringField(assertion, "credentialId", 1400), authenticatorData: stringField(assertion, "authenticatorData", 4000),
          clientDataJSON: stringField(assertion, "clientDataJSON", 8000), signature: stringField(assertion, "signature", 2000) },
      });
      return json(response, 200, { record: { seq: record.seq, target: record.target, recordHash: record.recordHash, createdAt: record.createdAt }, duplicate });
    }
    const reject = /^\/api\/proposals\/([^/]+)\/reject$/.exec(url.pathname);
    if (reject) {
      let id: string;
      try { id = decodeURIComponent(reject[1]!); } catch { throw new HttpError(400, "REQUEST_INVALID", { field: "proposalId" }); }
      service.rejectProposal(id);
      return json(response, 200, { ok: true });
    }
    throw new HttpError(404, "NOT_FOUND");
  }

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      await route(request, response);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof HttpError) return json(response, error.status, { error: { code: error.code, details: error.details } });
      if (error instanceof AdminError) return json(response, STATUS[error.code] ?? 400, { error: { code: error.code, details: error.details } });
      const reasonCode = (error as { details?: { reasonCode?: unknown } } | null)?.details?.reasonCode;
      return json(response, 503, { error: { code: "STORE_UNAVAILABLE", details: { reason: typeof reasonCode === "string" ? reasonCode : failureCode(error) ?? "UNEXPECTED_FAILURE" } } });
    }
  };
}

export interface AdminPageStartOptions {
  /** Where the shared state (the record of the address actually served) lives. */
  environment?: NodeJS.ProcessEnv;
  /** How often a server that left the page to another AGS server tries to take it over. */
  retryMs?: number;
  /** Stops the takeover attempts and closes a page this call opened. */
  signal?: AbortSignal;
}

const SERVER_OPTIONS = { requestTimeout: 30_000, headersTimeout: 10_000, maxHeaderSize: 16 * 1024 };
const TAKEOVER_RETRY_MS = 15_000;
const PROBE_TIMEOUT_MS = 2_000;
const PROBE_MAX_BYTES = 4 * 1024 * 1024;

function listenOn(port: number): Promise<{ server: Server } | { code: string }> {
  const server = createServer(SERVER_OPTIONS);
  return new Promise(resolve => {
    server.once("error", error => resolve({ code: (error as NodeJS.ErrnoException).code ?? "LISTEN_FAILED" }));
    server.listen(port, "127.0.0.1", () => {
      server.unref();
      resolve({ server });
    });
  });
}

/** Whether the program on the port answers as an AGS admin page; every AGS version serves the same shared state. */
function servesAgsPage(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const request = get({ host: "127.0.0.1", port, path: "/api/state", headers: { host: `localhost:${port}` }, timeout: PROBE_TIMEOUT_MS }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        text += chunk;
        if (text.length > PROBE_MAX_BYTES) response.destroy();
      });
      response.on("end", () => {
        try { resolve(response.statusCode === 200 && (JSON.parse(text) as { rpId?: unknown }).rpId === ADMIN_RP_ID); }
        catch { resolve(false); }
      });
      response.on("error", () => resolve(false));
      response.on("close", () => resolve(false));
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

/** Records the port this process serves the page on; the returned function removes the record while it is still ours. */
function recordServing(environment: NodeJS.ProcessEnv, port: number): () => void {
  const file = resolveAdminPageRecordPath(environment);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ port, pid: process.pid }));
    renameSync(temporary, file);
  } catch (cause) {
    writeDiagnostic("admin-page", "record-write-failed", { port, code: failureCode(cause) ?? "RECORD_WRITE_FAILED" });
  }
  return () => {
    const record = readAdminPageRecord(environment);
    if (record?.pid === process.pid && record.port === port) {
      try { rmSync(file, { force: true }); } catch { /* A record left behind names a process that is gone; readers skip it. */ }
    }
  };
}

/**
 * Opens the page on 127.0.0.1 (port 0 turns it off) and records the port it serves on in the shared state, which the
 * address given to the user follows (AGS3-D-0078). Several MCP servers run on one computer and serve the same shared
 * state, so one page is enough:
 * - the configured port is free: serve there;
 * - another AGS page holds the port (or serves the recorded address): leave the page to it, and try to take the
 *   configured port over every `retryMs` so the page survives that server's end;
 * - a program other than AGS holds the port: serve on a port the system picks.
 */
export async function startAdminPage(dependencies: AdminPageDependencies, options: AdminPageStartOptions = {}): Promise<Server | null> {
  if (dependencies.port === 0) return null;
  const environment = options.environment ?? process.env;
  const serve = (server: Server): Server => {
    const port = (server.address() as AddressInfo).port;
    server.on("request", createAdminRequestHandler({ ...dependencies, port }));
    const clear = recordServing(environment, port);
    server.once("close", clear);
    process.once("exit", clear);
    if (options.signal?.aborted) server.close();
    else options.signal?.addEventListener("abort", () => server.close(), { once: true });
    return server;
  };
  const attempt = async (): Promise<Server | "held" | null> => {
    const configured = await listenOn(dependencies.port);
    if ("server" in configured) return serve(configured.server);
    if (configured.code !== "EADDRINUSE") {
      writeDiagnostic("admin-page", "listen-failed", { port: dependencies.port, code: configured.code });
      return null;
    }
    const recorded = readAdminPageRecord(environment);
    if (await servesAgsPage(dependencies.port) || (recorded !== null && await servesAgsPage(recorded.port))) return "held";
    const picked = await listenOn(0);
    if (!("server" in picked)) {
      writeDiagnostic("admin-page", "listen-failed", { port: 0, code: picked.code });
      return null;
    }
    writeDiagnostic("admin-page", "port-held-by-other-program", { port: dependencies.port, served: (picked.server.address() as AddressInfo).port });
    return serve(picked.server);
  };
  const first = await attempt();
  if (first !== "held") return first;
  writeDiagnostic("admin-page", "port-in-use", { port: dependencies.port, code: "EADDRINUSE" });
  let busy = false;
  const retry = setInterval(() => {
    if (busy) return;
    busy = true;
    void attempt().then(result => { if (result !== "held") clearInterval(retry); }, () => clearInterval(retry)).finally(() => { busy = false; });
  }, options.retryMs ?? TAKEOVER_RETRY_MS);
  retry.unref();
  options.signal?.addEventListener("abort", () => clearInterval(retry), { once: true });
  return null;
}
