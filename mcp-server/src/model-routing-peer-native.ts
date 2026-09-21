/** Product identity and plugin-scoped paths stay at this native adapter boundary. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ModelRoutingStore } from "../../skills/coordinate-subagents/scripts/model-routing-store.mjs";
import { resolveSessionMessageStateDirectory, resolveWorkflowDatabasePath } from "./runtime-config.js";
import { requestSessionMessageOnce } from "./session-message-client.js";
import type { SessionMessage, SessionPresence } from "./session-message-store.js";
import { SqliteWorkflowStore } from "./sqlite-workflow-store.js";
import { ModelRoutingWorkflowBridge } from "./model-routing-workflow.js";
import { nativeRoutingActor, type NativeRoutingHost } from "./model-routing-host-hook.js";
import { ModelRoutingPeerSession } from "./model-routing-peer-session.js";
import { ModelPeerPacketSigner, peerCheck, peerIdentity, isModelPeerPacket } from "./model-peer-packet.js";

export async function openNativePeerSession(host: NativeRoutingHost, input: Record<string, unknown>) {
  peerCheck(process.env.AGENT_GOVERNANCE_PEER_ROUTING === "1", "Peer handoff admission is opt-in.");
  peerCheck(typeof input.session_id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(input.session_id)
    && !input.agent_id, "Peer handoffs require a native parent-session identity.");
  const directory = resolveSessionMessageStateDirectory();
  peerCheck(existsSync(path.join(directory, "endpoint.json")), "No existing session broker endpoint.");
  const response = await requestSessionMessageOnce<{ presence: SessionPresence }>("presence", { target: { host, sessionId: input.session_id } }, directory, 1500);
  const presence = response.presence;
  peerCheck(presence?.state === "online" && presence.instanceId && presence.leaseUntil && Date.parse(presence.leaseUntil) > Date.now(), "Native session is not current.");
  peerCheck(input.instance_id === undefined || input.instance_id === presence.instanceId, "Native session instance changed.");
  const identity = peerIdentity({ host, sessionId: input.session_id, instanceId: presence.instanceId });
  let databasePath: string;
  if (host === "claude-code") {
    peerCheck(process.env.CLAUDE_PLUGIN_DATA?.trim(), "Claude plugin data is required.");
    databasePath = path.join(process.env.CLAUDE_PLUGIN_DATA!, "workflows.sqlite3");
  } else databasePath = resolveWorkflowDatabasePath();
  // Missing local task/lease is a blocker, not permission to create/import one from a peer message.
  peerCheck(existsSync(databasePath), "The local workflow database has not been initialized.");
  const token = readFileSync(path.join(directory, "broker.token"), "utf8").trim();
  let workflow: SqliteWorkflowStore | null = null, database: DatabaseSync | null = null;
  try {
    workflow = new SqliteWorkflowStore(databasePath); database = new DatabaseSync(databasePath);
    database.exec("PRAGMA busy_timeout=1500;");
    const store = new ModelRoutingStore(database), bridge = new ModelRoutingWorkflowBridge(workflow, store);
    const session = new ModelRoutingPeerSession({ store, workflowBridge: bridge, identity,
      actorId: nativeRoutingActor(host, identity.sessionId, null), signer: new ModelPeerPacketSigner(token), stateDirectory: directory });
    const opened = database, openedWorkflow = workflow;
    return { session, close: () => { opened.close(); openedWorkflow.close(); } };
  } catch (error) { database?.close(); workflow?.close(); throw error; }
}

/** Called only after the existing hook has claimed a message and recorded its peer provenance. */
export async function observeNativePeerHandoff(host: NativeRoutingHost, input: Record<string, unknown>, message: SessionMessage): Promise<Record<string, unknown> | null> {
  if (process.env.AGENT_GOVERNANCE_PEER_ROUTING !== "1" || !isModelPeerPacket(message.body)) return null;
  let opened: Awaited<ReturnType<typeof openNativePeerSession>> | null = null;
  try {
    opened = await openNativePeerSession(host, input);
    const result = await opened.session.receive(message);
    return { ...result, kind: "ags-peer-handoff", executionAuthorized: false, trustedGateSatisfied: false };
  } catch {
    return { kind: "ags-peer-handoff", handoffState: "unavailable", executionAuthorized: false, executionStarted: false, completed: false };
  } finally { opened?.close(); }
}
