import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startAdminPage } from "../../mcp-server/src/admin-page-server.js";
import { ContextLayerService } from "../../mcp-server/src/context-layer-service.js";
import { adminPageUrl, resolveAdminPageUrl } from "../../mcp-server/src/runtime-config.js";

// AGS3-D-0078 (2026-11-08): the page listened once on its fixed port and gave up on EADDRINUSE. When the serving MCP
// server ended, the others never took the page over; when a program other than AGS held the port, nobody served it;
// and the address agents gave was always the fixed port, whatever served there.

let directory = "";
let environment: NodeJS.ProcessEnv = {};
const servers: Server[] = [];
const stops: AbortController[] = [];

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "ags-d0078-"));
});
afterEach(async () => {
  for (const stop of stops.splice(0)) stop.abort();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function listen(server: Server, port = 0): Promise<number> {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

/** A port nothing listens on now (the OS just handed it out and it was released). */
async function freePort(): Promise<number> {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise<void>(resolve => probe.close(() => resolve()));
  servers.splice(servers.indexOf(probe), 1);
  return port;
}

function getJson(port: number, pathname: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path: pathname, headers: { host: `localhost:${port}` } }, response => {
      let text = "";
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => {
        let body: Record<string, unknown> | null;
        try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = null; }
        resolve({ status: response.statusCode ?? 0, body });
      });
    }).on("error", reject);
  });
}

function page(port: number, retryMs = 50) {
  environment = { AGENT_GOVERNANCE_ADMIN_PORT: String(port), AGENT_GOVERNANCE_SHARED_STATE_DIR: directory };
  const service = new ContextLayerService(() => null);
  const stop = new AbortController();
  stops.push(stop);
  return startAdminPage({ service, port, listSessions: async () => [], settings: async () => ({}) as never },
    { environment, retryMs, signal: stop.signal });
}

async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

describe("AGS3-D-0078 the admin page when its port is taken", () => {
  it("serves on its port and gives that address", async () => {
    const port = await freePort();
    const server = (await page(port))!;
    servers.push(server);
    expect((server.address() as AddressInfo).port).toBe(port);
    expect((await getJson(port, "/api/state")).body?.rpId).toBe("localhost");
    expect(resolveAdminPageUrl(environment)).toBe(adminPageUrl(port));
  });

  it("serves on another port when a program other than AGS holds it, and gives that address", async () => {
    const foreign = createServer((_request, response) => { response.writeHead(200); response.end("not ags"); });
    const port = await listen(foreign);
    const server = (await page(port))!;
    expect(server).not.toBeNull();
    servers.push(server);
    const actual = (server.address() as AddressInfo).port;
    expect(actual).not.toBe(port);
    expect((await getJson(actual, "/api/state")).body?.rpId).toBe("localhost");
    expect(resolveAdminPageUrl(environment)).toBe(adminPageUrl(actual));
  });

  it("leaves the page to the AGS server that holds the port and takes it over when that server ends", async () => {
    const port = await freePort();
    const first = (await page(port))!;
    expect(first).not.toBeNull();
    const second = await page(port);
    expect(second).toBeNull();
    await new Promise<void>(resolve => first.close(() => resolve()));
    // The record names the server that ended; the address falls back to the configured port meanwhile.
    await until(async () => {
      try { return (await getJson(port, "/api/state")).body?.rpId === "localhost"; } catch { return false; }
    });
    expect(resolveAdminPageUrl(environment)).toBe(adminPageUrl(port));
  });

  it("gives the configured address when the record names a process that is gone or cannot be read", () => {
    environment = { AGENT_GOVERNANCE_ADMIN_PORT: "47615", AGENT_GOVERNANCE_SHARED_STATE_DIR: directory };
    expect(resolveAdminPageUrl(environment)).toBe(adminPageUrl(47615));
    writeFileSync(path.join(directory, "admin-page.json"), JSON.stringify({ port: 51234, pid: 2 ** 22 + 12345 }));
    expect(resolveAdminPageUrl(environment)).toBe(adminPageUrl(47615));
    writeFileSync(path.join(directory, "admin-page.json"), "{not json");
    expect(resolveAdminPageUrl(environment)).toBe(adminPageUrl(47615));
    writeFileSync(path.join(directory, "admin-page.json"), JSON.stringify({ port: 51234, pid: process.pid }));
    expect(resolveAdminPageUrl(environment)).toBe(adminPageUrl(51234));
  });

  it("gives no address when the page is turned off", () => {
    expect(resolveAdminPageUrl({ AGENT_GOVERNANCE_ADMIN_PORT: "0", AGENT_GOVERNANCE_SHARED_STATE_DIR: directory })).toBeNull();
  });
});
