import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { StoredPluginUpdateState } from "../../mcp-server/src/plugin-update-store.js";
import {
  InMemoryPluginUpdateStore,
  type PluginUpdateStore,
} from "../../mcp-server/src/plugin-update-store.js";
import {
  compareStableVersions,
  PluginUpdateService,
} from "../../mcp-server/src/plugin-update-service.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";

const commit = "a".repeat(40);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function sqliteStores(): Promise<[SqliteWorkflowStore, SqliteWorkflowStore]> {
  const directory = await mkdtemp(join(tmpdir(), "plugin-update-concurrency-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "workflows.sqlite3");
  return [new SqliteWorkflowStore(databasePath), new SqliteWorkflowStore(databasePath)];
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function reference(version: string, sha = commit): Record<string, unknown> {
  return {
    ref: `refs/tags/${version}`,
    object: {
      sha,
      type: "commit",
      url: `https://api.github.com/repos/jaeseongs95/agent-governance-suite/git/commits/${sha}`,
    },
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

describe("PluginUpdateService", () => {
  it("compares strict stable SemVer numerically", () => {
    expect(compareStableVersions("1.9.0", "1.10.0")).toBe(-1);
    expect(compareStableVersions("2.0.0", "1.99.99")).toBe(1);
    expect(compareStableVersions("1.1.0", "1.1.0")).toBe(0);
    expect(() => compareStableVersions("1.1.0-beta.1", "1.1.0")).toThrow(/stable SemVer/u);
  });

  it("caches a successful check for 24 hours and force bypasses the cache", async () => {
    const store = new InMemoryPluginUpdateStore();
    let now = new Date("2026-09-13T00:00:00.000Z");
    let calls = 0;
    const service = new PluginUpdateService(store, {
      now: () => now,
      fetcher: async () => {
        calls += 1;
        return jsonResponse([
          reference("v1.9.0"),
          reference("v1.10.0"),
          reference("v2.0.0-beta.1"),
          reference("latest"),
        ], { headers: { etag: "fixture-etag" } });
      },
    });

    const first = await service.check();
    expect(first).toMatchObject({
      latestVersion: "1.10.0",
      latestTag: "v1.10.0",
      comparison: "update-available",
      stale: false,
      lastErrorCode: null,
    });
    new ContractValidator().pluginUpdateStatus(first);

    now = new Date("2026-09-13T12:00:00.000Z");
    expect((await service.check()).latestVersion).toBe("1.10.0");
    expect(calls).toBe(1);

    await service.check(true);
    expect(calls).toBe(2);
  });

  it("reports ahead-of-stable without emitting a notice", async () => {
    const service = new PluginUpdateService(new InMemoryPluginUpdateStore(), {
      fetcher: async () => jsonResponse([reference("v1.0.5")]),
    });
    const status = await service.check();
    expect(status.comparison).toBe("ahead-of-stable");
    expect(service.takeNotice(status)).toBeNull();
  });

  it("preserves the last successful result and retries one hour after failure", async () => {
    const store = new InMemoryPluginUpdateStore();
    let now = new Date("2026-09-13T00:00:00.000Z");
    let fail = false;
    let calls = 0;
    const service = new PluginUpdateService(store, {
      now: () => now,
      fetcher: async () => {
        calls += 1;
        if (fail) throw new TypeError("offline");
        return jsonResponse([reference("v1.2.0")]);
      },
    });

    await service.check();
    fail = true;
    now = new Date("2026-09-14T00:00:00.000Z");
    const failed = await service.check();
    expect(failed).toMatchObject({
      latestVersion: "1.2.0",
      comparison: "update-available",
      stale: true,
      lastErrorCode: "NETWORK",
      nextCheckAt: "2026-09-14T01:00:00.000Z",
    });

    now = new Date("2026-09-14T00:30:00.000Z");
    await service.check();
    expect(calls).toBe(2);
  });

  it("emits each available version once and persists that claim", async () => {
    const store = new InMemoryPluginUpdateStore();
    let now = new Date("2026-09-13T00:00:00.000Z");
    let latest = "v1.2.0";
    const firstService = new PluginUpdateService(store, {
      now: () => now,
      fetcher: async () => jsonResponse([reference(latest)]),
    });

    const first = await firstService.check();
    const notice = firstService.takeNotice(first);
    expect(notice).toMatchObject({ latestVersion: "1.2.0", automaticInstall: false });
    if (!notice) throw new Error("Expected an update notice.");
    new ContractValidator().pluginUpdateNotice(notice);
    expect(firstService.takeNotice(first)).toBeNull();

    const restarted = new PluginUpdateService(store, {
      now: () => now,
      fetcher: async () => jsonResponse([reference(latest)]),
    });
    expect(restarted.takeNotice(await restarted.check())).toBeNull();

    latest = "v1.3.0";
    now = new Date("2026-09-14T00:00:00.000Z");
    const next = await restarted.check();
    expect(restarted.takeNotice(next)).toMatchObject({ latestVersion: "1.3.0" });
  });

  it("preserves a concurrent SQLite notice claim against a stale check write", async () => {
    const [firstStore, secondStore] = await sqliteStores();
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    const firstService = new PluginUpdateService(firstStore, { fetcher: async () => firstResponse.promise });
    const secondService = new PluginUpdateService(secondStore, { fetcher: async () => secondResponse.promise });

    const firstCheck = firstService.check(true);
    const secondCheck = secondService.check(true);
    firstResponse.resolve(jsonResponse([reference("v1.2.0")]));
    const firstStatus = await firstCheck;
    expect(firstService.takeNotice(firstStatus)?.latestVersion).toBe("1.2.0");

    secondResponse.resolve(jsonResponse([reference("v1.2.0")]));
    const secondStatus = await secondCheck;
    expect(secondService.takeNotice(secondStatus)).toBeNull();
    expect(secondStore.getPluginUpdateState("agent-governance-suite")?.lastNotifiedVersion).toBe("1.2.0");
    firstStore.close();
    secondStore.close();
  });

  it("preserves a concurrent successful SQLite result when a stale check fails", async () => {
    const [successStore, failureStore] = await sqliteStores();
    const successResponse = deferred<Response>();
    const failureResponse = deferred<Response>();
    const successService = new PluginUpdateService(successStore, { fetcher: async () => successResponse.promise });
    const failureService = new PluginUpdateService(failureStore, { fetcher: async () => failureResponse.promise });

    const successfulCheck = successService.check(true);
    const failedCheck = failureService.check(true);
    successResponse.resolve(jsonResponse([reference("v1.2.0")]));
    expect(await successfulCheck).toMatchObject({ latestVersion: "1.2.0", lastErrorCode: null });

    failureResponse.reject(new TypeError("offline"));
    expect(await failedCheck).toMatchObject({ latestVersion: "1.2.0", lastErrorCode: "NETWORK" });
    expect(failureStore.getPluginUpdateState("agent-governance-suite")).toMatchObject({
      latestVersion: "1.2.0",
      lastErrorCode: "NETWORK",
    });
    successStore.close();
    failureStore.close();
  });

  it("does not notify an older version after a higher version was already claimed", async () => {
    const store = new InMemoryPluginUpdateStore();
    let latest = "v1.2.0";
    const service = new PluginUpdateService(store, {
      fetcher: async () => jsonResponse([reference(latest)]),
    });

    const versions: Array<string | undefined> = [];
    versions.push(service.takeNotice(await service.check(true))?.latestVersion);
    latest = "v1.3.0";
    versions.push(service.takeNotice(await service.check(true))?.latestVersion);
    latest = "v1.2.0";
    versions.push(service.takeNotice(await service.check(true))?.latestVersion);

    expect(versions).toEqual(["1.2.0", "1.3.0", undefined]);
    expect(store.getPluginUpdateState("agent-governance-suite")?.lastNotifiedVersion).toBe("1.3.0");
  });

  it.each([
    { label: "HTTP failure", response: () => new Response("rate limited", { status: 403 }), code: "HTTP" },
    { label: "non-array JSON", response: () => jsonResponse({ tags: [] }), code: "INVALID_RESPONSE" },
    { label: "no stable tag", response: () => jsonResponse([reference("v1.2.0-beta.1")]), code: "NO_STABLE_TAG" },
  ])("records $label without throwing", async ({ response, code }) => {
    const service = new PluginUpdateService(new InMemoryPluginUpdateStore(), {
      fetcher: async () => response(),
    });
    expect(await service.check()).toMatchObject({ comparison: "unknown", stale: true, lastErrorCode: code });
  });

  it("classifies the three-second abort boundary as TIMEOUT", async () => {
    const service = new PluginUpdateService(new InMemoryPluginUpdateStore(), {
      requestTimeoutMs: 5,
      fetcher: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }),
    });
    expect(await service.check()).toMatchObject({ lastErrorCode: "TIMEOUT", stale: true });
  });

  it("uses volatile state when update storage fails", async () => {
    const failingStore: PluginUpdateStore = {
      getPluginUpdateState() { throw new Error("read failed"); },
      putPluginUpdateState() { throw new Error("write failed"); },
      claimPluginUpdateNotice() { throw new Error("claim failed"); },
    };
    const service = new PluginUpdateService(failingStore, {
      fetcher: async () => jsonResponse([reference("v1.2.0")]),
    });
    const status = await service.check();
    expect(status.comparison).toBe("update-available");
    expect(service.takeNotice(status)).toBeNull();
    expect(service.takeNotice(status)).toBeNull();
  });

  it("suppresses a notice when its durable claim cannot be recorded", async () => {
    const durable = new InMemoryPluginUpdateStore();
    const claimFailureStore: PluginUpdateStore = {
      getPluginUpdateState: (targetId) => durable.getPluginUpdateState(targetId),
      putPluginUpdateState: (state) => durable.putPluginUpdateState(state),
      claimPluginUpdateNotice() { throw new Error("claim failed"); },
    };
    const firstService = new PluginUpdateService(claimFailureStore, {
      fetcher: async () => jsonResponse([reference("v1.2.0")]),
    });
    expect(firstService.takeNotice(await firstService.check())).toBeNull();

    const restarted = new PluginUpdateService(claimFailureStore, {
      fetcher: async () => jsonResponse([reference("v1.2.0")]),
    });
    expect(restarted.takeNotice(await restarted.check())).toBeNull();
    expect(durable.getPluginUpdateState("agent-governance-suite")?.lastNotifiedVersion).toBeNull();
  });

  it("does not throw when the stored last-notified version is malformed", async () => {
    const store = new InMemoryPluginUpdateStore();
    const state: StoredPluginUpdateState = {
      targetId: "agent-governance-suite",
      currentVersion: "1.1.0",
      latestVersion: "1.2.0",
      latestTag: "v1.2.0",
      latestCommit: commit,
      etag: null,
      comparison: "update-available",
      lastAttemptAt: "2026-09-13T00:00:00.000Z",
      lastSuccessfulCheckAt: "2026-09-13T00:00:00.000Z",
      nextCheckAt: "2026-09-14T00:00:00.000Z",
      lastNotifiedVersion: "not-semver",
      lastNotifiedAt: "2026-09-13T00:00:00.000Z",
      lastErrorCode: null,
    };
    store.putPluginUpdateState(state);
    const service = new PluginUpdateService(store, {
      now: () => new Date("2026-09-13T01:00:00.000Z"),
      fetcher: async () => jsonResponse([reference("v1.2.0")]),
    });

    const status = await service.check();
    expect(status.comparison).toBe("update-available");
    expect(() => service.takeNotice(status)).not.toThrow();
    expect(service.takeNotice(status)).toBeNull();
  });

  it("reuses a cached ETag after a 304 response", async () => {
    const store = new InMemoryPluginUpdateStore();
    const initial: StoredPluginUpdateState = {
      targetId: "agent-governance-suite",
      currentVersion: "1.1.0",
      latestVersion: "1.2.0",
      latestTag: "v1.2.0",
      latestCommit: commit,
      etag: "cached-etag",
      comparison: "update-available",
      lastAttemptAt: "2026-09-12T00:00:00.000Z",
      lastSuccessfulCheckAt: "2026-09-12T00:00:00.000Z",
      nextCheckAt: "2026-09-13T00:00:00.000Z",
      lastNotifiedVersion: null,
      lastNotifiedAt: null,
      lastErrorCode: null,
    };
    store.putPluginUpdateState(initial);
    let sentEtag: string | null = null;
    const service = new PluginUpdateService(store, {
      now: () => new Date("2026-09-13T00:00:00.000Z"),
      fetcher: async (_input, init) => {
        sentEtag = new Headers(init?.headers).get("if-none-match");
        return new Response(null, { status: 304 });
      },
    });
    const status = await service.check();
    expect(sentEtag).toBe("cached-etag");
    expect(status).toMatchObject({ latestVersion: "1.2.0", stale: false, lastErrorCode: null });
  });

  it("dereferences an annotated stable tag to its commit", async () => {
    const tagObjectSha = "b".repeat(40);
    const commitSha = "c".repeat(40);
    const tagObjectUrl = `https://api.github.com/repos/jaeseongs95/agent-governance-suite/git/tags/${tagObjectSha}`;
    const service = new PluginUpdateService(new InMemoryPluginUpdateStore(), {
      fetcher: async (input) => input.includes("matching-refs")
        ? jsonResponse([{
            ref: "refs/tags/v1.2.0",
            object: { sha: tagObjectSha, type: "tag", url: tagObjectUrl },
          }])
        : jsonResponse({
            object: {
              sha: commitSha,
              type: "commit",
              url: `https://api.github.com/repos/jaeseongs95/agent-governance-suite/git/commits/${commitSha}`,
            },
          }),
    });
    expect(await service.check()).toMatchObject({ latestVersion: "1.2.0", latestCommit: commitSha });
  });
});
