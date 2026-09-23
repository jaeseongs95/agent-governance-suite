import { createHash } from "node:crypto";
import { homedir } from "node:os";

import {
  assertDistinctDatabasePaths,
  canonicalDatabasePath,
  resolveContinuityDatabasePath,
  resolveResourceDatabasePath,
  resolveWorkflowDatabasePath,
} from "../runtime-config.js";

export interface ResourceAuthorityConfig {
  databasePath: string;
  realmId: string;
  authorityId: "ags-resource-authority-v1";
  ownerMode: "single-broker";
}

/** Resolve one ledger per shared user state root, independent of workflow paths. */
export function resolveResourceAuthorityConfig(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = homedir(),
  currentWorkingDirectory: string = process.cwd(),
): ResourceAuthorityConfig {
  const databasePath = resolveResourceDatabasePath(environment, homeDirectory);
  assertDistinctDatabasePaths(databasePath, resolveWorkflowDatabasePath(environment, platform, homeDirectory, currentWorkingDirectory), platform);
  assertDistinctDatabasePaths(databasePath, resolveContinuityDatabasePath(environment, platform, homeDirectory, currentWorkingDirectory), platform);
  const canonicalPath = canonicalDatabasePath(databasePath, platform);
  if (canonicalPath === null) throw new Error("Resource database must be a file.");
  return {
    databasePath,
    realmId: createHash("sha256").update(canonicalPath).digest("hex"),
    authorityId: "ags-resource-authority-v1",
    ownerMode: "single-broker",
  };
}

/** Reject a caller's different realm before it can use the shared ledger. */
export function assertResourceAuthorityIdentity(
  actual: ResourceAuthorityConfig,
  expected: Pick<ResourceAuthorityConfig, "realmId" | "authorityId">,
): void {
  if (actual.realmId !== expected.realmId || actual.authorityId !== expected.authorityId) {
    throw new Error("Resource authority realm or identity mismatch.");
  }
}
