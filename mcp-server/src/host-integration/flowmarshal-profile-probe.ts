import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { InMemoryWorkflowStore } from "../workflow-store.js";
import { FlowmarshalCurrentInvocation } from "./flowmarshal-current-invocation.js";
import { loadFlowmarshalProfileFile } from "./flowmarshal-profile.js";
import { buildCurrentHostIntegrationManifest, parseHostIntegrationManifest } from "./manifest.js";

const PROFILE_ID = "flowmarshal-same-user-v1";
const PROBE_PATH = "mcp-server/dist/flowmarshal-profile-probe.mjs";

/** Local package and temporary A2 state check. This does not observe a model or run FM's check set. */
export function probeFlowmarshalProfileState(packageRoot: string): {
  status: "PASS";
  evidenceClass: "local_derived";
  profileId: typeof PROFILE_ID;
  freezeIdentity: string;
  manifestSha256: string;
  surfaceChecks: {
    unsignedRegistrationRejected: true;
    unboundObservationRejected: true;
    unreservedExecutionRejected: true;
  };
  surfaces: { registration: string; observation: string; execution: string[] };
} {
  const root = realpathSync(packageRoot);
  const manifestBytes = readFileSync(path.join(root, "host-integration.json"));
  const manifest = parseHostIntegrationManifest(JSON.parse(manifestBytes.toString("utf8")), root);
  if (!isDeepStrictEqual(manifest, buildCurrentHostIntegrationManifest(root))) {
    throw new Error("FlowMarshal A2 package manifest omits or adds execution closure files");
  }
  const entry = manifest.entryPoints.find((item) => item.id === "mcp-server");
  if (entry?.path !== "mcp-server/dist/server.mjs" || !entry.executionClosure.includes(PROBE_PATH)
      || !manifest.artifacts?.some((artifact) => artifact.path === PROBE_PATH)) {
    throw new Error("FlowMarshal A2 probe or MCP entry point is not in the package manifest closure");
  }
  // The server resolves this exact path beside its own bundle. A caller cannot nominate another profile.
  const profile = loadFlowmarshalProfileFile(path.join(root, PROFILE_ID, "server-profile.json"));
  if (!profile || profile.profileId !== PROFILE_ID) throw new Error("FlowMarshal A2 profile is unavailable");
  const invocation = new FlowmarshalCurrentInvocation(profile, new InMemoryWorkflowStore());
  try {
    let unsignedRegistrationRejected = false;
    try { invocation.reserve({}); }
    catch (error) { unsignedRegistrationRejected = error instanceof Error
      && error.message.includes("signed registration is malformed"); }
    let unreservedExecutionRejected = false;
    try { invocation.readCurrentInvocation(); }
    catch (error) { unreservedExecutionRejected = error instanceof Error
      && error.message.includes("current reserved request is unavailable"); }
    const unboundObservationRejected = invocation.observe({
      phase: "bootstrap", taskId: "probe-only", runId: null, stageId: null, revision: null,
    }) === null;
    if (invocation.hasCurrentRequest() || !unsignedRegistrationRejected
        || !unboundObservationRejected || !unreservedExecutionRejected) {
      throw new Error("FlowMarshal A2 invocation surfaces are not isolated");
    }
    return {
      status: "PASS", evidenceClass: "local_derived", profileId: PROFILE_ID,
      freezeIdentity: profile.freezeIdentity,
      manifestSha256: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`,
      surfaceChecks: { unsignedRegistrationRejected: true, unboundObservationRejected: true,
        unreservedExecutionRejected: true },
      surfaces: {
        registration: "fm/reserve_dispatch",
        observation: "signed-current-receipt",
        execution: ["plan_workflow", "record_stage_result"],
      },
    };
  } finally { invocation.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error("Usage: node mcp-server/dist/flowmarshal-profile-probe.mjs");
    const root = fileURLToPath(new URL("../../", import.meta.url));
    process.stdout.write(`${JSON.stringify(probeFlowmarshalProfileState(root))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
