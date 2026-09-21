/** A bounded transfer journal, not a second task queue. The broker's message spool owns delivery. */
import type { DatabaseSync } from "node:sqlite";
import { convergenceDigest } from "./convergence-logic.js";
import { peerCheck, peerMessageId, type PeerDisposition } from "./model-peer-packet.js";
import type { ModelRoutingDecisionV2 } from "../../contracts/types.js";

export interface PeerTransfer {
  packetId: string;
  decisionDigest: string;
  body: string;
  direction: "outbound" | "inbound";
  state: "prepared" | "processing" | "sent" | PeerDisposition;
  reply: string | null;
  expiresAt: string;
}
export class ModelPeerJournal {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`CREATE TABLE IF NOT EXISTS ags_model_peer_transfers_v1 (
      packet_id TEXT NOT NULL, direction TEXT NOT NULL, decision_digest TEXT NOT NULL,
      binding_digest TEXT NOT NULL, write_key TEXT, body TEXT NOT NULL, state TEXT NOT NULL,
      reply TEXT, expires_at TEXT NOT NULL, PRIMARY KEY(packet_id,direction)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS ags_model_peer_outbound_decision_v1
      ON ags_model_peer_transfers_v1(decision_digest) WHERE direction='outbound';
    CREATE UNIQUE INDEX IF NOT EXISTS ags_model_peer_active_write_v1
      ON ags_model_peer_transfers_v1(write_key) WHERE direction='outbound' AND write_key IS NOT NULL
      AND state IN ('prepared','sent','unknown','accepted');`);
  }
  private transaction<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  get(packetId: string, direction: PeerTransfer["direction"] = "outbound"): PeerTransfer | null {
    const row = this.database.prepare(`SELECT packet_id AS packetId, decision_digest AS decisionDigest,
      direction,body,state,reply,expires_at AS expiresAt FROM ags_model_peer_transfers_v1 WHERE packet_id=? AND direction=?`).get(packetId, direction);
    return row as unknown as PeerTransfer | undefined ?? null;
  }
  outbound(decisionDigest: string): PeerTransfer | null {
    const row = this.database.prepare("SELECT packet_id FROM ags_model_peer_transfers_v1 WHERE direction='outbound' AND decision_digest=?")
      .get(decisionDigest) as { packet_id: string } | undefined;
    return row ? this.get(row.packet_id) : null;
  }
  prepare(direction: PeerTransfer["direction"], decision: Pick<ModelRoutingDecisionV2, "decisionDigest" | "binding">, body: string, write: boolean, expiresAt: string): PeerTransfer {
    const packetId = peerMessageId(body);
    return this.transaction(() => {
      const prior = this.get(packetId, direction);
      if (prior) {
        peerCheck(prior.direction === direction && prior.decisionDigest === decision.decisionDigest && prior.body === body, "Peer transfer conflict.");
        return prior;
      }
      // Never delete ambiguous or accepted reservations merely because a delivery TTL expired.
      const count = this.database.prepare("SELECT COUNT(*) AS n FROM ags_model_peer_transfers_v1").get() as { n: number };
      peerCheck(count.n < 256, "Peer transfer journal is full; resolve retained transfers before new handoffs.");
      const b = decision.binding;
      const writeKey = direction === "outbound" && write ? convergenceDigest({ taskId: b.taskId, runId: b.runId, stageId: b.stageId }) : null;
      this.database.prepare("INSERT INTO ags_model_peer_transfers_v1 VALUES (?,?,?,?,?,?,'prepared',NULL,?)")
        .run(packetId, direction, decision.decisionDigest, convergenceDigest(b), writeKey, body, expiresAt);
      return this.get(packetId, direction)!;
    });
  }
  claimInbound(packetId: string): boolean {
    return Number(this.database.prepare("UPDATE ags_model_peer_transfers_v1 SET state='processing' WHERE packet_id=? AND direction='inbound' AND state='prepared' AND reply IS NULL").run(packetId).changes) === 1;
  }
  sent(packetId: string): void {
    this.database.prepare("UPDATE ags_model_peer_transfers_v1 SET state='sent' WHERE packet_id=? AND state IN ('prepared','unknown') AND direction='outbound'").run(packetId);
  }
  unknown(packetId: string): void {
    this.database.prepare("UPDATE ags_model_peer_transfers_v1 SET state='unknown' WHERE packet_id=? AND direction='outbound' AND state IN ('prepared','sent')").run(packetId);
  }
  settle(packetId: string, disposition: PeerDisposition, reply: string, direction: PeerTransfer["direction"] = "outbound"): PeerTransfer {
    return this.transaction(() => {
      const transfer = this.get(packetId, direction); peerCheck(transfer, "Unknown peer transfer.");
      // A definitive response is immutable. An ACK or a later refusal cannot undo an acceptance.
      if (transfer.reply !== null) {
        peerCheck(transfer.state === disposition && transfer.reply === reply, "Conflicting peer acceptance receipt.");
        return transfer;
      }
      this.database.prepare("UPDATE ags_model_peer_transfers_v1 SET state=?,reply=? WHERE packet_id=? AND direction=? AND reply IS NULL")
        .run(disposition, reply, packetId, direction);
      return this.get(packetId, direction)!;
    });
  }
}
