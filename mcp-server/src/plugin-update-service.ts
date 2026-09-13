import {
  type PluginUpdateComparison,
  type PluginUpdateErrorCode,
  type PluginUpdateNoticeV1,
  type PluginUpdateStatusV1,
} from "../../contracts/types.js";
import { PLUGIN_INFO } from "./plugin-info.js";
import {
  compareStableVersionNumbers,
  parseStableVersion,
} from "./plugin-version.js";
import {
  type PluginUpdateStore,
  type StoredPluginUpdateState,
} from "./plugin-update-store.js";

const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const FAILURE_RETRY_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 3_000;
const STABLE_TAG = /^refs\/tags\/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const TAG_OBJECT_URL_PREFIX = `${PLUGIN_INFO.tagsApi.split("/git/matching-refs/")[0]}/git/tags/`;

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

interface RemoteTagReference {
  ref: string;
  object: {
    sha: string;
    type: string;
    url: string;
  };
}

interface ServiceOptions {
  fetcher?: Fetcher;
  now?: () => Date;
  requestTimeoutMs?: number;
  successTtlMs?: number;
  failureRetryMs?: number;
}

class UpdateCheckError extends Error {
  constructor(readonly code: PluginUpdateErrorCode, message: string) {
    super(message);
  }
}

function safeDate(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stateTimestamp(state: StoredPluginUpdateState | null): number {
  if (!state) return -1;
  return Math.max(
    safeDate(state.lastAttemptAt) ?? -1,
    safeDate(state.lastNotifiedAt) ?? -1,
  );
}

export function compareStableVersions(current: string, latest: string): number {
  try {
    return compareStableVersionNumbers(current, latest);
  } catch (cause) {
    throw new UpdateCheckError(
      "INVALID_RESPONSE",
      cause instanceof Error ? cause.message : "A plugin version is not strict stable SemVer.",
    );
  }
}

function comparison(current: string, latest: string): PluginUpdateComparison {
  const order = compareStableVersions(current, latest);
  return order < 0 ? "update-available" : order > 0 ? "ahead-of-stable" : "up-to-date";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function remoteReference(value: unknown): RemoteTagReference | null {
  if (!isRecord(value) || typeof value.ref !== "string" || !isRecord(value.object)) return null;
  const object = value.object;
  return typeof object.sha === "string" && typeof object.type === "string" && typeof object.url === "string"
    ? { ref: value.ref, object: { sha: object.sha, type: object.type, url: object.url } }
    : null;
}

export class PluginUpdateService {
  private readonly fetcher: Fetcher;
  private readonly now: () => Date;
  private readonly requestTimeoutMs: number;
  private readonly successTtlMs: number;
  private readonly failureRetryMs: number;
  private volatileState: StoredPluginUpdateState | null = null;

  constructor(
    private readonly store: PluginUpdateStore,
    options: ServiceOptions = {},
  ) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.successTtlMs = options.successTtlMs ?? SUCCESS_TTL_MS;
    this.failureRetryMs = options.failureRetryMs ?? FAILURE_RETRY_MS;
  }

  async check(force = false): Promise<PluginUpdateStatusV1> {
    const now = this.now();
    const stored = this.readState();
    let current: StoredPluginUpdateState;
    try {
      current = this.withCurrentVersion(stored, now);
    } catch {
      current = { ...this.emptyState(now), lastErrorCode: "INVALID_RESPONSE" };
    }
    const nextCheck = safeDate(current.nextCheckAt);
    if (!force && nextCheck !== null && now.getTime() < nextCheck) {
      return this.publicStatus(current, now);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetcher(PLUGIN_INFO.tagsApi, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `${PLUGIN_INFO.id}/${PLUGIN_INFO.version}`,
          ...(current.etag ? { "If-None-Match": current.etag } : {}),
        },
        redirect: "error",
        signal: controller.signal,
      });
      const updated = response.status === 304
        ? this.notModified(current, now)
        : await this.fromResponse(response, current, now, controller.signal);
      this.writeState(updated);
      return this.publicStatus(this.readState() ?? updated, now);
    } catch (error) {
      const code = this.errorCode(error, controller.signal.aborted);
      const failed: StoredPluginUpdateState = {
        ...current,
        lastAttemptAt: now.toISOString(),
        nextCheckAt: new Date(now.getTime() + this.failureRetryMs).toISOString(),
        lastErrorCode: code,
      };
      this.writeState(failed);
      return this.publicStatus(this.readState() ?? failed, now);
    } finally {
      clearTimeout(timeout);
    }
  }

  takeNotice(status: PluginUpdateStatusV1): PluginUpdateNoticeV1 | null {
    if (
      status.comparison !== "update-available"
      || !status.latestVersion
      || !status.latestTag
      || !status.latestCommit
      || !status.lastSuccessfulCheckAt
    ) return null;

    const state = this.volatileState ?? this.readState();
    if (state?.lastNotifiedVersion) {
      try {
        if (compareStableVersions(state.lastNotifiedVersion, status.latestVersion) >= 0) return null;
      } catch {
        return null;
      }
    }
    const notifiedAt = this.now().toISOString();
    const notice: PluginUpdateNoticeV1 = {
      schemaVersion: "1.0.0",
      kind: "plugin-update-notice",
      pluginId: PLUGIN_INFO.id,
      currentVersion: status.currentVersion,
      latestVersion: status.latestVersion,
      latestTag: status.latestTag,
      latestCommit: status.latestCommit,
      checkedAt: status.lastSuccessfulCheckAt,
      tagUrl: `${PLUGIN_INFO.repository}/tree/${status.latestTag}`,
      automaticInstall: false,
    };

    let claimed: boolean;
    try {
      claimed = this.store.claimPluginUpdateNotice(PLUGIN_INFO.id, status.latestVersion, notifiedAt);
    } catch {
      return null;
    }
    if (!claimed) return null;
    this.volatileState = {
      ...(state ?? this.withCurrentVersion(null, this.now())),
      lastNotifiedVersion: status.latestVersion,
      lastNotifiedAt: notifiedAt,
    };
    return notice;
  }

  private readState(): StoredPluginUpdateState | null {
    try {
      const stored = this.store.getPluginUpdateState(PLUGIN_INFO.id);
      const current = stateTimestamp(stored) >= stateTimestamp(this.volatileState)
        ? stored
        : this.volatileState;
      if (current) this.volatileState = current;
      return current;
    } catch {
      return this.volatileState;
    }
  }

  private writeState(state: StoredPluginUpdateState): void {
    this.volatileState = state;
    try {
      this.store.putPluginUpdateState(state);
    } catch {
      // Update checks are advisory and must not block workflow tools.
    }
  }

  private withCurrentVersion(state: StoredPluginUpdateState | null, now: Date): StoredPluginUpdateState {
    if (!state) return this.emptyState(now);
    const latestIsValid = state.latestVersion === null
      ? state.latestTag === null && state.latestCommit === null
      : parseStableVersion(state.latestVersion) !== null
        && state.latestTag === `v${state.latestVersion}`
        && typeof state.latestCommit === "string"
        && /^[a-f0-9]{40}$/u.test(state.latestCommit);
    if (
      !parseStableVersion(state.currentVersion)
      || !latestIsValid
      || safeDate(state.nextCheckAt) === null
      || (state.lastAttemptAt !== null && safeDate(state.lastAttemptAt) === null)
      || (state.lastSuccessfulCheckAt !== null && safeDate(state.lastSuccessfulCheckAt) === null)
      || (state.lastNotifiedVersion !== null && parseStableVersion(state.lastNotifiedVersion) === null)
      || (state.lastNotifiedAt !== null && safeDate(state.lastNotifiedAt) === null)
    ) {
      throw new UpdateCheckError("INVALID_RESPONSE", "Stored plugin update state is invalid.");
    }
    return {
      ...state,
      currentVersion: PLUGIN_INFO.version,
      comparison: state.latestVersion ? comparison(PLUGIN_INFO.version, state.latestVersion) : "unknown",
    };
  }

  private emptyState(now: Date): StoredPluginUpdateState {
    return {
      targetId: PLUGIN_INFO.id,
      currentVersion: PLUGIN_INFO.version,
      latestVersion: null,
      latestTag: null,
      latestCommit: null,
      etag: null,
      comparison: "unknown",
      lastAttemptAt: null,
      lastSuccessfulCheckAt: null,
      nextCheckAt: now.toISOString(),
      lastNotifiedVersion: null,
      lastNotifiedAt: null,
      lastErrorCode: null,
    };
  }

  private notModified(state: StoredPluginUpdateState, now: Date): StoredPluginUpdateState {
    if (!state.latestVersion || !state.latestTag || !state.latestCommit) {
      throw new UpdateCheckError("INVALID_RESPONSE", "GitHub returned 304 without a cached stable tag.");
    }
    return {
      ...state,
      currentVersion: PLUGIN_INFO.version,
      comparison: comparison(PLUGIN_INFO.version, state.latestVersion),
      lastAttemptAt: now.toISOString(),
      lastSuccessfulCheckAt: now.toISOString(),
      nextCheckAt: new Date(now.getTime() + this.successTtlMs).toISOString(),
      lastErrorCode: null,
    };
  }

  private async fromResponse(
    response: Response,
    state: StoredPluginUpdateState,
    now: Date,
    signal: AbortSignal,
  ): Promise<StoredPluginUpdateState> {
    if (!response.ok) throw new UpdateCheckError("HTTP", `GitHub tags request failed with HTTP ${response.status}.`);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new UpdateCheckError("INVALID_RESPONSE", "GitHub tags response was not JSON.");
    }
    if (!Array.isArray(body)) throw new UpdateCheckError("INVALID_RESPONSE", "GitHub tags response was not an array.");
    const stable = body.flatMap((item) => {
      const reference = remoteReference(item);
      const match = reference ? STABLE_TAG.exec(reference.ref) : null;
      return reference && match ? [{ reference, version: `${match[1]}.${match[2]}.${match[3]}` }] : [];
    });
    if (stable.length === 0) throw new UpdateCheckError("NO_STABLE_TAG", "GitHub returned no stable plugin tag.");
    stable.sort((left, right) => compareStableVersions(right.version, left.version));
    const latest = stable[0]!;
    const commit = await this.resolveCommit(latest.reference.object, signal);
    return {
      ...state,
      currentVersion: PLUGIN_INFO.version,
      latestVersion: latest.version,
      latestTag: `v${latest.version}`,
      latestCommit: commit,
      etag: response.headers.get("etag"),
      comparison: comparison(PLUGIN_INFO.version, latest.version),
      lastAttemptAt: now.toISOString(),
      lastSuccessfulCheckAt: now.toISOString(),
      nextCheckAt: new Date(now.getTime() + this.successTtlMs).toISOString(),
      lastErrorCode: null,
    };
  }

  private async resolveCommit(
    initial: RemoteTagReference["object"],
    signal: AbortSignal,
  ): Promise<string> {
    let current = initial;
    for (let depth = 0; depth < 5; depth += 1) {
      if (current.type === "commit" && /^[a-f0-9]{40}$/u.test(current.sha)) return current.sha;
      if (current.type !== "tag" || !current.url.startsWith(TAG_OBJECT_URL_PREFIX)) {
        throw new UpdateCheckError("INVALID_RESPONSE", "A stable tag did not resolve to a repository commit.");
      }
      const response = await this.fetcher(current.url, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `${PLUGIN_INFO.id}/${PLUGIN_INFO.version}`,
        },
        redirect: "error",
        signal,
      });
      if (!response.ok) throw new UpdateCheckError("HTTP", `GitHub tag object request failed with HTTP ${response.status}.`);
      let value: unknown;
      try {
        value = await response.json() as unknown;
      } catch {
        throw new UpdateCheckError("INVALID_RESPONSE", "GitHub tag object response was not JSON.");
      }
      if (!isRecord(value) || !isRecord(value.object)) {
        throw new UpdateCheckError("INVALID_RESPONSE", "GitHub tag object response was invalid.");
      }
      const object = value.object;
      if (typeof object.sha !== "string" || typeof object.type !== "string" || typeof object.url !== "string") {
        throw new UpdateCheckError("INVALID_RESPONSE", "GitHub tag object target was invalid.");
      }
      current = { sha: object.sha, type: object.type, url: object.url };
    }
    throw new UpdateCheckError("INVALID_RESPONSE", "GitHub tag indirection exceeded the supported depth.");
  }

  private errorCode(error: unknown, aborted: boolean): PluginUpdateErrorCode {
    if (aborted || (error instanceof Error && error.name === "AbortError")) return "TIMEOUT";
    if (error instanceof UpdateCheckError) return error.code;
    return "NETWORK";
  }

  private publicStatus(state: StoredPluginUpdateState, now: Date): PluginUpdateStatusV1 {
    const nextCheck = safeDate(state.nextCheckAt);
    return {
      schemaVersion: "1.0.0",
      pluginId: PLUGIN_INFO.id,
      currentVersion: PLUGIN_INFO.version,
      latestVersion: state.latestVersion,
      latestTag: state.latestTag,
      latestCommit: state.latestCommit,
      comparison: state.comparison,
      lastAttemptAt: state.lastAttemptAt,
      lastSuccessfulCheckAt: state.lastSuccessfulCheckAt,
      nextCheckAt: state.nextCheckAt,
      stale: state.lastSuccessfulCheckAt === null
        || state.lastErrorCode !== null
        || nextCheck === null
        || now.getTime() >= nextCheck,
      lastErrorCode: state.lastErrorCode,
      automaticInstall: false,
    };
  }
}
