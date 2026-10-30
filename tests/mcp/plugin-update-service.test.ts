import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { StoredPluginUpdateState } from "../../mcp-server/src/plugin-update-store.js";
import {
  InMemoryPluginUpdateStore,
  mergePluginUpdateState,
  type PluginUpdateStore,
} from "../../mcp-server/src/plugin-update-store.js";
import { compareInstalledVersion, isInstalledVersion } from "../../mcp-server/src/plugin-version.js";
import {
  compareStableVersions,
  PluginUpdateService,
} from "../../mcp-server/src/plugin-update-service.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { CURRENT_VERSION, NEXT_NEXT_TAG, NEXT_NEXT_VERSION, NEXT_TAG, NEXT_VERSION } from "./version-fixtures.js";

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

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TAG_REFERENCES = 10_000;
const encoder = new TextEncoder();

function streamResponse(
  chunks: Array<Uint8Array | Error>,
  options: { onCancel?: () => void | Promise<void>; onPull?: (index: number) => void } = {},
): Response {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      options.onPull?.(index);
      const item = chunks[index];
      index += 1;
      if (item === undefined) {
        controller.close();
        return;
      }
      if (item instanceof Error) {
        controller.error(item);
        return;
      }
      controller.enqueue(item);
    },
    cancel() {
      return options.onCancel?.();
    },
  }, { highWaterMark: 0 });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function paddedJsonBytes(value: unknown, totalBytes: number): Uint8Array {
  const base = JSON.stringify(value);
  const padLength = totalBytes - Buffer.byteLength(base, "utf8");
  if (padLength < 0) throw new Error(`Base JSON already exceeds ${totalBytes} bytes.`);
  return encoder.encode(`${base}${" ".repeat(padLength)}`);
}

describe("PluginUpdateService", () => {
  it("compares strict stable SemVer numerically", () => {
    expect(compareStableVersions("1.9.0", "1.10.0")).toBe(-1);
    expect(compareStableVersions("2.0.0", "1.99.99")).toBe(1);
    expect(compareStableVersions("1.1.0", "1.1.0")).toBe(0);
    expect(() => compareStableVersions("1.1.0-beta.1", "1.1.0")).toThrow(/stable SemVer/u);
  });

  it("orders a prerelease build before its own stable release and after earlier ones", () => {
    expect(compareInstalledVersion("3.0.0-rc.1", "2.9.1")).toBe(1);
    expect(compareInstalledVersion("3.0.0-rc.1", "3.0.0")).toBe(-1);
    expect(compareInstalledVersion("3.0.0-rc-1.2", "3.0.1")).toBe(-1);
    expect(compareInstalledVersion("3.0.0", "3.0.0")).toBe(0);
    expect(() => compareInstalledVersion("3.0.0-rc.1", "3.0.0-rc.1")).toThrow(/stable SemVer/u);
    expect(isInstalledVersion("3.0.0-rc.1")).toBe(true);
    for (const version of ["3.0.0-", "3.0.0-rc..1", "03.0.0-rc.1", "v3.0.0-rc.1"]) expect(isInstalledVersion(version), version).toBe(false);

    const state: StoredPluginUpdateState = {
      targetId: "agent-governance-suite", currentVersion: "3.0.0-rc.1", latestVersion: "2.9.1", latestTag: "v2.9.1",
      latestCommit: commit, etag: null, comparison: "unknown", lastAttemptAt: "2026-09-13T00:00:00.000Z",
      lastSuccessfulCheckAt: "2026-09-13T00:00:00.000Z", nextCheckAt: "2026-09-14T00:00:00.000Z",
      lastNotifiedVersion: null, lastNotifiedAt: null, lastErrorCode: null,
    };
    expect(mergePluginUpdateState(state, state).comparison).toBe("ahead-of-stable");
    expect(mergePluginUpdateState(state, { ...state, latestVersion: "3.0.0", latestTag: "v3.0.0" }).comparison)
      .toBe("update-available");
    expect(() => new ContractValidator().pluginUpdateStatus({
      schemaVersion: "1.0.0", pluginId: "agent-governance-suite", currentVersion: "3.0.0-rc.1", latestVersion: "2.9.1",
      latestTag: "v2.9.1", latestCommit: commit, comparison: "ahead-of-stable", lastAttemptAt: state.lastAttemptAt,
      lastSuccessfulCheckAt: state.lastSuccessfulCheckAt, nextCheckAt: state.nextCheckAt, stale: false, lastErrorCode: null,
      automaticInstall: false,
    })).not.toThrow();
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
          reference(NEXT_TAG),
          reference(NEXT_NEXT_TAG),
          reference("v2.0.0-beta.1"),
          reference("latest"),
        ], { headers: { etag: "fixture-etag" } });
      },
    });

    const first = await service.check();
    expect(first).toMatchObject({
      latestVersion: NEXT_NEXT_VERSION,
      latestTag: NEXT_NEXT_TAG,
      comparison: "update-available",
      stale: false,
      lastErrorCode: null,
    });
    new ContractValidator().pluginUpdateStatus(first);

    now = new Date("2026-09-13T12:00:00.000Z");
    expect((await service.check()).latestVersion).toBe(NEXT_NEXT_VERSION);
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
        return jsonResponse([reference(NEXT_TAG)]);
      },
    });

    await service.check();
    fail = true;
    now = new Date("2026-09-14T00:00:00.000Z");
    const failed = await service.check();
    expect(failed).toMatchObject({
      latestVersion: NEXT_VERSION,
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
    let latest = NEXT_TAG;
    const firstService = new PluginUpdateService(store, {
      now: () => now,
      fetcher: async () => jsonResponse([reference(latest)]),
    });

    const first = await firstService.check();
    const notice = firstService.takeNotice(first);
    expect(notice).toMatchObject({ latestVersion: NEXT_VERSION, automaticInstall: false });
    if (!notice) throw new Error("Expected an update notice.");
    new ContractValidator().pluginUpdateNotice(notice);
    expect(firstService.takeNotice(first)).toBeNull();

    const restarted = new PluginUpdateService(store, {
      now: () => now,
      fetcher: async () => jsonResponse([reference(latest)]),
    });
    expect(restarted.takeNotice(await restarted.check())).toBeNull();

    latest = NEXT_NEXT_TAG;
    now = new Date("2026-09-14T00:00:00.000Z");
    const next = await restarted.check();
    expect(restarted.takeNotice(next)).toMatchObject({ latestVersion: NEXT_NEXT_VERSION });
  });

  it("preserves a concurrent SQLite notice claim against a stale check write", async () => {
    const [firstStore, secondStore] = await sqliteStores();
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    const firstService = new PluginUpdateService(firstStore, { fetcher: async () => firstResponse.promise });
    const secondService = new PluginUpdateService(secondStore, { fetcher: async () => secondResponse.promise });

    const firstCheck = firstService.check(true);
    const secondCheck = secondService.check(true);
    firstResponse.resolve(jsonResponse([reference(NEXT_TAG)]));
    const firstStatus = await firstCheck;
    expect(firstService.takeNotice(firstStatus)?.latestVersion).toBe(NEXT_VERSION);

    secondResponse.resolve(jsonResponse([reference(NEXT_TAG)]));
    const secondStatus = await secondCheck;
    expect(secondService.takeNotice(secondStatus)).toBeNull();
    expect(secondStore.getPluginUpdateState("agent-governance-suite")?.lastNotifiedVersion).toBe(NEXT_VERSION);
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
    successResponse.resolve(jsonResponse([reference(NEXT_TAG)]));
    expect(await successfulCheck).toMatchObject({ latestVersion: NEXT_VERSION, lastErrorCode: null });

    failureResponse.reject(new TypeError("offline"));
    expect(await failedCheck).toMatchObject({ latestVersion: NEXT_VERSION, lastErrorCode: "NETWORK" });
    expect(failureStore.getPluginUpdateState("agent-governance-suite")).toMatchObject({
      latestVersion: NEXT_VERSION,
      lastErrorCode: "NETWORK",
    });
    successStore.close();
    failureStore.close();
  });

  it("does not notify an older version after a higher version was already claimed", async () => {
    const store = new InMemoryPluginUpdateStore();
    let latest = NEXT_TAG;
    const service = new PluginUpdateService(store, {
      fetcher: async () => jsonResponse([reference(latest)]),
    });

    const versions: Array<string | undefined> = [];
    versions.push(service.takeNotice(await service.check(true))?.latestVersion);
    latest = NEXT_NEXT_TAG;
    versions.push(service.takeNotice(await service.check(true))?.latestVersion);
    latest = NEXT_TAG;
    versions.push(service.takeNotice(await service.check(true))?.latestVersion);

    expect(versions).toEqual([NEXT_VERSION, NEXT_NEXT_VERSION, undefined]);
    expect(store.getPluginUpdateState("agent-governance-suite")?.lastNotifiedVersion).toBe(NEXT_NEXT_VERSION);
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
      fetcher: async () => jsonResponse([reference(NEXT_TAG)]),
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
      fetcher: async () => jsonResponse([reference(NEXT_TAG)]),
    });
    expect(firstService.takeNotice(await firstService.check())).toBeNull();

    const restarted = new PluginUpdateService(claimFailureStore, {
      fetcher: async () => jsonResponse([reference(NEXT_TAG)]),
    });
    expect(restarted.takeNotice(await restarted.check())).toBeNull();
    expect(durable.getPluginUpdateState("agent-governance-suite")?.lastNotifiedVersion).toBeNull();
  });

  it("does not throw when the stored last-notified version is malformed", async () => {
    const store = new InMemoryPluginUpdateStore();
    const state: StoredPluginUpdateState = {
      targetId: "agent-governance-suite",
      currentVersion: CURRENT_VERSION,
      latestVersion: NEXT_VERSION,
      latestTag: NEXT_TAG,
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
      fetcher: async () => jsonResponse([reference(NEXT_TAG)]),
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
      currentVersion: CURRENT_VERSION,
      latestVersion: NEXT_VERSION,
      latestTag: NEXT_TAG,
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
    expect(status).toMatchObject({ latestVersion: NEXT_VERSION, stale: false, lastErrorCode: null });
  });

  it("dereferences an annotated stable tag to its commit", async () => {
    const tagObjectSha = "b".repeat(40);
    const commitSha = "c".repeat(40);
    const tagObjectUrl = `https://api.github.com/repos/jaeseongs95/agent-governance-suite/git/tags/${tagObjectSha}`;
    const service = new PluginUpdateService(new InMemoryPluginUpdateStore(), {
      fetcher: async (input) => input.includes("matching-refs")
        ? jsonResponse([{
            ref: `refs/tags/${NEXT_TAG}`,
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
    expect(await service.check()).toMatchObject({ latestVersion: NEXT_VERSION, latestCommit: commitSha });
  });

  it.each(["tags", "tag-object"] as const)(
    "distinguishes mid-stream non-abort read failures from malformed JSON on %s endpoint",
    async (endpoint) => {
      const tagObjectSha = "b".repeat(40);
      const tagObjectUrl = `https://api.github.com/repos/jaeseongs95/agent-governance-suite/git/tags/${tagObjectSha}`;
      const annotatedRef = [{
        ref: `refs/tags/${NEXT_TAG}`,
        object: { sha: tagObjectSha, type: "tag", url: tagObjectUrl },
      }];

      const withEndpointResponse = (targetResponse: () => Response): PluginUpdateService =>
        new PluginUpdateService(new InMemoryPluginUpdateStore(), {
          fetcher: async (input) => {
            if (input.includes("matching-refs")) {
              return endpoint === "tags" ? targetResponse() : jsonResponse(annotatedRef);
            }
            return targetResponse();
          },
        });

      const networkStatus = await withEndpointResponse(() =>
        streamResponse([encoder.encode('[{"ref":'), new Error("socket reset")]),
      ).check();
      expect(networkStatus).toMatchObject({
        comparison: "unknown",
        stale: true,
        lastErrorCode: "NETWORK",
      });

      const malformedStatus = await withEndpointResponse(() =>
        streamResponse([encoder.encode('[{"ref":'), encoder.encode('"unterminated')]),
      ).check();
      expect(malformedStatus).toMatchObject({
        comparison: "unknown",
        stale: true,
        lastErrorCode: "INVALID_RESPONSE",
      });
    },
  );

  it.each(["tags", "tag-object"] as const)(
    "enforces the 1MiB response byte budget, cancels on overflow without extra pulls, and preserves INVALID_RESPONSE when cancel rejects on %s endpoint",
    async (endpoint) => {
      const tagObjectSha = "b".repeat(40);
      const commitSha = "c".repeat(40);
      const tagObjectUrl = `https://api.github.com/repos/jaeseongs95/agent-governance-suite/git/tags/${tagObjectSha}`;
      const annotatedRef = [{
        ref: `refs/tags/${NEXT_TAG}`,
        object: { sha: tagObjectSha, type: "tag", url: tagObjectUrl },
      }];
      const validPayload = endpoint === "tags"
        ? [reference(NEXT_TAG, commitSha)]
        : {
            object: {
              sha: commitSha,
              type: "commit",
              url: `https://api.github.com/repos/jaeseongs95/agent-governance-suite/git/commits/${commitSha}`,
            },
          };

      const runWithResponse = (targetResponse: () => Response): ReturnType<PluginUpdateService["check"]> =>
        new PluginUpdateService(new InMemoryPluginUpdateStore(), {
          fetcher: async (input) => {
            if (input.includes("matching-refs")) {
              return endpoint === "tags" ? targetResponse() : jsonResponse(annotatedRef);
            }
            return targetResponse();
          },
        }).check();

      const exactBytes = paddedJsonBytes(validPayload, MAX_RESPONSE_BYTES);
      expect(exactBytes.byteLength).toBe(MAX_RESPONSE_BYTES);
      const exactStatus = await runWithResponse(() =>
        streamResponse([exactBytes.subarray(0, 512 * 1024), exactBytes.subarray(512 * 1024)]),
      );
      expect(exactStatus).toMatchObject({
        latestVersion: NEXT_VERSION,
        latestCommit: commitSha,
        comparison: "update-available",
        stale: false,
        lastErrorCode: null,
      });

      const boundaryOverflow = paddedJsonBytes(validPayload, MAX_RESPONSE_BYTES + 1);
      const trailingChunk = new Uint8Array(512 * 1024).fill(0x20);
      const boundaryPulls: number[] = [];
      let boundaryCancelled = false;
      const boundaryStatus = await runWithResponse(() =>
        streamResponse([boundaryOverflow, trailingChunk], {
          onPull: (index) => { boundaryPulls.push(index); },
          onCancel: () => { boundaryCancelled = true; },
        }),
      );
      expect(boundaryCancelled).toBe(true);
      expect(boundaryPulls).toEqual([0]);
      expect(boundaryStatus).toMatchObject({
        comparison: "unknown",
        stale: true,
        lastErrorCode: "INVALID_RESPONSE",
      });

      const pulls: number[] = [];
      let multiChunkCancelled = false;
      const halfMiB = new Uint8Array(512 * 1024).fill(0x20);
      const overflowByte = new Uint8Array([0x20]);
      const multiChunkStatus = await runWithResponse(() =>
        streamResponse([halfMiB, halfMiB, overflowByte, trailingChunk], {
          onPull: (index) => { pulls.push(index); },
          onCancel: async () => {
            multiChunkCancelled = true;
            throw new Error("cancel failed");
          },
        }),
      );
      expect(multiChunkCancelled).toBe(true);
      expect(pulls).toEqual([0, 1, 2]);
      expect(multiChunkStatus).toMatchObject({
        comparison: "unknown",
        stale: true,
        lastErrorCode: "INVALID_RESPONSE",
      });
    },
  );

  it("accepts 10,000 tag references and rejects 10,001 without truncating away newer tags", async () => {
    const fillerRef = {
      ref: "refs/tags/v0.0.1-rc.1",
      object: { sha: "0", type: "tag", url: "" },
    };
    const exactRefs = [
      ...Array.from({ length: MAX_TAG_REFERENCES - 2 }, () => fillerRef),
      reference(`v${CURRENT_VERSION}`),
      reference(NEXT_TAG),
    ];
    expect(exactRefs).toHaveLength(MAX_TAG_REFERENCES);
    expect(Buffer.byteLength(JSON.stringify(exactRefs), "utf8")).toBeLessThan(MAX_RESPONSE_BYTES);

    const exactService = new PluginUpdateService(new InMemoryPluginUpdateStore(), {
      fetcher: async () => jsonResponse(exactRefs),
    });
    expect(await exactService.check()).toMatchObject({
      latestVersion: NEXT_VERSION,
      latestTag: NEXT_TAG,
      comparison: "update-available",
      stale: false,
      lastErrorCode: null,
    });

    const overflowRefs = [
      ...Array.from({ length: MAX_TAG_REFERENCES - 1 }, () => fillerRef),
      reference(`v${CURRENT_VERSION}`),
      reference(NEXT_NEXT_TAG),
    ];
    expect(overflowRefs).toHaveLength(MAX_TAG_REFERENCES + 1);
    expect(Buffer.byteLength(JSON.stringify(overflowRefs), "utf8")).toBeLessThan(MAX_RESPONSE_BYTES);

    const overflowService = new PluginUpdateService(new InMemoryPluginUpdateStore(), {
      fetcher: async () => jsonResponse(overflowRefs),
    });
    expect(await overflowService.check()).toMatchObject({
      latestVersion: null,
      latestTag: null,
      comparison: "unknown",
      stale: true,
      lastErrorCode: "INVALID_RESPONSE",
    });
  });

  it.each(["tags", "tag-object"] as const)(
    "preserves TIMEOUT when a response body stream aborts mid-read on %s endpoint",
    async (endpoint) => {
      const tagObjectSha = "b".repeat(40);
      const tagObjectUrl = `https://api.github.com/repos/jaeseongs95/agent-governance-suite/git/tags/${tagObjectSha}`;
      const annotatedRef = [{
        ref: `refs/tags/${NEXT_TAG}`,
        object: { sha: tagObjectSha, type: "tag", url: tagObjectUrl },
      }];

      const abortingStreamResponse = (signal?: AbortSignal | null): Response => {
        let firstChunkSent = false;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!firstChunkSent) {
              firstChunkSent = true;
              controller.enqueue(encoder.encode('[{"ref":'));
              return;
            }
            return new Promise<void>((_resolve, reject) => {
              const onAbort = (): void => {
                reject(new DOMException("The operation was aborted.", "AbortError"));
              };
              if (signal?.aborted) {
                onAbort();
                return;
              }
              signal?.addEventListener("abort", onAbort, { once: true });
            });
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };

      const service = new PluginUpdateService(new InMemoryPluginUpdateStore(), {
        requestTimeoutMs: 5,
        fetcher: async (input, init) => {
          if (input.includes("matching-refs")) {
            return endpoint === "tags"
              ? abortingStreamResponse(init?.signal)
              : jsonResponse(annotatedRef);
          }
          return abortingStreamResponse(init?.signal);
        },
      });

      expect(await service.check()).toMatchObject({
        comparison: "unknown",
        stale: true,
        lastErrorCode: "TIMEOUT",
      });
    },
  );
});
