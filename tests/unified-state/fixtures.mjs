export const scopeA = Object.freeze({ host: "fixture-host", sessionId: "fixture-session", taskId: "fixture-task-a" });
export const scopeB = Object.freeze({ host: "fixture-host", sessionId: "fixture-session", taskId: "fixture-task-b" });
export const sourceId = "fixture-source-original";
export const workflowRow = Object.freeze({ run_id: "original-run-id", revision: 4, state: "ready", receipt_json: '{"runId":"original-run-id","revision":4,"state":"ready"}', created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" });
export const workflowRef = Object.freeze({ module: "workflow", sourceId, table: "workflow_runs", key: { run_id: "original-run-id" } });
export function nextWorkflowRow() { return { ...workflowRow, revision: 5, state: "running", receipt_json: '{"runId":"original-run-id","revision":5,"state":"running"}' }; }
export function records(scope = scopeA) {
  return [
    { module: "workflow", table: "workflow_runs", scope, row: { ...workflowRow } },
    { module: "continuity", table: "continuity_tasks", scope, row: { task_correlation: "original-correlation-not-rederived", current_epoch: 2, root_id: "original-root-id", suppressed: 0, pending_revision: 7, pending_digest: "original-checkpoint-digest", pending_consumed: 0, updated_at: "2026-01-01T00:00:00.000Z" } },
    { module: "continuity", table: "continuity_snapshots", scope, row: { task_correlation: "original-correlation-not-rederived", epoch: 2, revision: 7, snapshot_digest: "original-checkpoint-digest", snapshot_json: '{"source":"direct","candidateKind":"historical","revision":7}', updated_at: "2026-01-01T00:00:00.000Z" } },
    { module: "continuity", table: "continuity_requests", scope, row: { task_correlation: "original-correlation-not-rederived", epoch: 2, request_hash: "original-request-hash", command_digest: "original-command-digest", result_json: '{"state":"UNKNOWN","revision":7}', created_at: "2026-01-01T00:00:00.000Z" } },
    { module: "board", table: "sessions", scope, row: { host: scope.host, session_id: scope.sessionId, cwd: "fixture-workspace", summary: "비활성 fixture 검사", summary_at: null, last_prompt_at: null, denied_for: null, started_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" } },
    { module: "messaging", table: "messages", scope, row: { message_id: "original-message-id", sender_host: "fixture-peer", sender_session_id: "fixture-peer-session", target_host: scope.host, target_session_id: scope.sessionId, body: "새 synthetic fixture body", body_bytes: 26, created_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-01-01T01:00:00.000Z", claimed_at: null, claim_until: null, delivery_attempts: 2, first_delivered_at: "2026-01-01T00:01:00.000Z", acknowledged_at: null } },
    { module: "trust", table: "input_source_receipts", scope, row: { receipt_id: "original-provenance-receipt", host: scope.host, session_id: scope.sessionId, event_id: "original-event-id", origin_kind: "peer", authority_effect: "none", observed_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-01-01T01:00:00.000Z", receipt_json: '{"receiptId":"original-provenance-receipt","authorityEffect":"none","integrityToken":"synthetic-public-signature-NOT-verified"}' } },
  ];
}
export function snapshot(scope = scopeA, suppliedRecords = records(scope), versions = { workflow: 5, continuity: 2, board: 0, messaging: 1, trust: 1 }) {
  return JSON.stringify({ sourceId, moduleVersions: versions, records: suppliedRecords });
}
export function reference(entry) {
  const columns = { workflow_runs: ["run_id"], continuity_tasks: ["task_correlation"], continuity_snapshots: ["task_correlation", "epoch"], continuity_requests: ["task_correlation", "epoch", "request_hash"], sessions: ["host", "session_id"], messages: ["message_id"], input_source_receipts: ["receipt_id"] };
  return { module: entry.module, sourceId, table: entry.table, key: Object.fromEntries(columns[entry.table].map((key) => [key, entry.row[key]])) };
}
