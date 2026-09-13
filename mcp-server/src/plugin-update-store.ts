import {
  type PluginUpdateComparison,
  type PluginUpdateErrorCode,
} from "../../contracts/types.js";
import { compareStableVersionNumbers } from "./plugin-version.js";

export interface StoredPluginUpdateState {
  targetId: string;
  currentVersion: string;
  latestVersion: string | null;
  latestTag: string | null;
  latestCommit: string | null;
  etag: string | null;
  comparison: PluginUpdateComparison;
  lastAttemptAt: string | null;
  lastSuccessfulCheckAt: string | null;
  nextCheckAt: string;
  lastNotifiedVersion: string | null;
  lastNotifiedAt: string | null;
  lastErrorCode: PluginUpdateErrorCode | null;
}

export interface PluginUpdateStore {
  getPluginUpdateState(targetId: string): StoredPluginUpdateState | null;
  putPluginUpdateState(state: StoredPluginUpdateState): void;
  claimPluginUpdateNotice(targetId: string, latestVersion: string, notifiedAt: string): boolean;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function timestamp(value: string | null): number {
  if (value === null) return -1;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : -1;
}

function comparison(currentVersion: string, latestVersion: string | null): PluginUpdateComparison {
  if (!latestVersion) return "unknown";
  const order = compareStableVersionNumbers(currentVersion, latestVersion);
  return order < 0 ? "update-available" : order > 0 ? "ahead-of-stable" : "up-to-date";
}

export function mergePluginUpdateState(
  existing: StoredPluginUpdateState | null,
  incoming: StoredPluginUpdateState,
): StoredPluginUpdateState {
  if (!existing) return clone(incoming);
  const incomingSuccessTime = timestamp(incoming.lastSuccessfulCheckAt);
  const existingSuccessTime = timestamp(existing.lastSuccessfulCheckAt);
  const sameTimeVersionIsNotOlder = incoming.latestVersion !== null
    && (existing.latestVersion === null
      || compareStableVersionNumbers(incoming.latestVersion, existing.latestVersion) >= 0);
  const incomingSuccessIsNewer = incoming.lastSuccessfulCheckAt !== null
    && (incomingSuccessTime > existingSuccessTime
      || (incomingSuccessTime === existingSuccessTime && sameTimeVersionIsNotOlder));
  const incomingAttemptIsNewer = timestamp(incoming.lastAttemptAt) >= timestamp(existing.lastAttemptAt);
  const latestVersion = incomingSuccessIsNewer ? incoming.latestVersion : existing.latestVersion;
  return {
    targetId: incoming.targetId,
    currentVersion: incoming.currentVersion,
    latestVersion,
    latestTag: incomingSuccessIsNewer ? incoming.latestTag : existing.latestTag,
    latestCommit: incomingSuccessIsNewer ? incoming.latestCommit : existing.latestCommit,
    etag: incomingSuccessIsNewer ? incoming.etag : existing.etag,
    comparison: comparison(incoming.currentVersion, latestVersion),
    lastAttemptAt: incomingAttemptIsNewer ? incoming.lastAttemptAt : existing.lastAttemptAt,
    lastSuccessfulCheckAt: incomingSuccessIsNewer
      ? incoming.lastSuccessfulCheckAt
      : existing.lastSuccessfulCheckAt,
    nextCheckAt: incomingAttemptIsNewer ? incoming.nextCheckAt : existing.nextCheckAt,
    lastNotifiedVersion: existing.lastNotifiedVersion,
    lastNotifiedAt: existing.lastNotifiedAt,
    lastErrorCode: incomingAttemptIsNewer ? incoming.lastErrorCode : existing.lastErrorCode,
  };
}

export class InMemoryPluginUpdateStore implements PluginUpdateStore {
  private readonly states = new Map<string, StoredPluginUpdateState>();

  getPluginUpdateState(targetId: string): StoredPluginUpdateState | null {
    const state = this.states.get(targetId);
    return state ? clone(state) : null;
  }

  putPluginUpdateState(state: StoredPluginUpdateState): void {
    this.states.set(state.targetId, mergePluginUpdateState(this.states.get(state.targetId) ?? null, state));
  }

  claimPluginUpdateNotice(targetId: string, latestVersion: string, notifiedAt: string): boolean {
    const state = this.states.get(targetId);
    if (
      !state
      || state.latestVersion !== latestVersion
      || (state.lastNotifiedVersion !== null
        && compareStableVersionNumbers(state.lastNotifiedVersion, latestVersion) >= 0)
    ) return false;
    state.lastNotifiedVersion = latestVersion;
    state.lastNotifiedAt = notifiedAt;
    return true;
  }
}
