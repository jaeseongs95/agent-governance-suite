import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { AdminError, type AdminErrorCode, ADMIN_RP_ID } from "./admin-webauthn.js";
import { ADMIN_PAGE_HTML } from "./admin-page.generated.js";
import { ROLE_NAME_MAX_LENGTH } from "./admin-log.js";
import { type AdminPageState, type ContextLayerService, GLOBAL_CONTEXT_MAX_BYTES, ROLE_CONTEXT_MAX_BYTES } from "./context-layer-service.js";
import { failureCode } from "./failure-diagnostics.js";
import { writeDiagnostic } from "./hook-error-diagnostics.js";

/**
 * The local admin page (AGS3-T-0024): node:http on 127.0.0.1, opened as http://localhost:<port> (a WebAuthn relying
 * party ID cannot be an IP address). Viewing needs no passkey; every change is a record the user's passkey signs, and
 * the service verifies it. The checks here keep other web pages out (DNS rebinding, cross-site POST); they are not what
 * protects a change from an agent on this computer — the signature is.
 */
export const ADMIN_BODY_MAX_BYTES = 64 * 1024;

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
}

export interface AdminSettingsView {
  locale: { value: string; source: string; lockedBy: string | null; editable: false; reason: string };
  jev: { configured: boolean; enabled: boolean; mode: string | null; profileCount: number; error: string | null; lockedBy: string; editable: false; reason: string };
  editGateExceptions: { available: true; paths: string[]; lockedBy: string; editable: false; reason: string };
}

export interface AdminPageDependencies {
  service: ContextLayerService;
  port: number;
  /** The sessions this computer's presence and board know; throws when they cannot be read. */
  listSessions: () => Promise<AdminSessionView[]>;
  settings: () => Promise<AdminSettingsView>;
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
      settings: await dependencies.settings(),
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
      const { record, duplicate } = service.commit({
        intent: stringField(body, "intent", ADMIN_BODY_MAX_BYTES), requestId, proposalId,
        assertion: { credentialId: stringField(assertion, "credentialId", 1400), authenticatorData: stringField(assertion, "authenticatorData", 4000),
          clientDataJSON: stringField(assertion, "clientDataJSON", 8000), signature: stringField(assertion, "signature", 2000) },
      });
      return json(response, 200, { record: { seq: record.seq, target: record.target, recordHash: record.recordHash, createdAt: record.createdAt }, duplicate });
    }
    const reject = /^\/api\/proposals\/([^/]+)\/reject$/.exec(url.pathname);
    if (reject) {
      service.rejectProposal(decodeURIComponent(reject[1]!));
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

/**
 * Opens the page on 127.0.0.1:<port> (port 0 turns it off). Several MCP servers run on one computer; the first one
 * serves the page and the others skip with a diagnostic (they share the same state file, so any one of them serves
 * the same page).
 */
export function startAdminPage(dependencies: AdminPageDependencies): Promise<Server | null> {
  if (dependencies.port === 0) return Promise.resolve(null);
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000, maxHeaderSize: 16 * 1024 }, createAdminRequestHandler(dependencies));
  return new Promise(resolve => {
    server.once("error", error => {
      const code = (error as NodeJS.ErrnoException).code ?? "LISTEN_FAILED";
      writeDiagnostic("admin-page", code === "EADDRINUSE" ? "port-in-use" : "listen-failed", { port: dependencies.port, code });
      resolve(null);
    });
    server.listen(dependencies.port, "127.0.0.1", () => {
      server.unref();
      resolve(server);
    });
  });
}
