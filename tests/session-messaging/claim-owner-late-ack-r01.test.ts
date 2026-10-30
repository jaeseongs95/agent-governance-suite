import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchSessionMessageBrokerOperation } from "../../mcp-server/src/session-message-broker.js";
import { type SessionMessage, SessionMessageStore } from "../../mcp-server/src/session-message-store.js";

const CLAIM_LEASE_BASE_MS = 120_000;
const CLAIM_LEASE_MAX_MS = 30 * 60_000;

interface ClaimReceiptEntry {
  messageId: string;
  claimReceipt: string;
}

type ClaimedMessageWithReceipt = SessionMessage & {
  claimReceipt?: string;
};

/**
 * Type-only call helper so TypeScript signatures match the 4-argument post-repair contract.
 * Note: On the pre-repair 4dfc6162 baseline, the 4th argument is ignored at runtime and
 * messages.claim_receipt does not exist; Test 1 isolates the 4dfc6162 counterexample
 * without relying on new fields, columns, or the 4th parameter.
 */
type AcknowledgeWithReceipts = (
  target: { host: string; sessionId: string },
  messageIds: string[],
  nowMs?: number,
  claims?: readonly ClaimReceiptEntry[],
) => number;

interface TempStoreResource {
  dir: string;
  dbPath: string;
  store: SessionMessageStore;
  auxDbs: Array<{ db: DatabaseSync; closed: boolean }>;
  storeClosed: boolean;
}

const resources: TempStoreResource[] = [];

function claimLeaseMs(deliveryAttempt: number): number {
  return Math.min(CLAIM_LEASE_MAX_MS, CLAIM_LEASE_BASE_MS * 2 ** Math.min(deliveryAttempt - 1, 4));
}

function setSystemNow(nowMs: number): void {
  vi.spyOn(Date, "now").mockReturnValue(nowMs);
}

function createTempStore(): {
  dir: string;
  dbPath: string;
  store: SessionMessageStore;
  openInspectorDb: () => DatabaseSync;
} {
  const dir = mkdtempSync(join(tmpdir(), "ags-d0354-ack-r01-"));
  const dbPath = join(dir, "session-messages.sqlite");
  const store = new SessionMessageStore(dbPath);
  const auxDbs: Array<{ db: DatabaseSync; closed: boolean }> = [];
  resources.push({ dir, dbPath, store, auxDbs, storeClosed: false });
  return {
    dir,
    dbPath,
    store,
    openInspectorDb: () => {
      const db = new DatabaseSync(dbPath);
      auxDbs.push({ db, closed: false });
      return db;
    },
  };
}

function acknowledgeStore(
  store: SessionMessageStore,
  target: { host: string; sessionId: string },
  messageIds: string[],
  nowMs: number,
  claims?: readonly ClaimReceiptEntry[],
): number {
  const fn = store.acknowledge.bind(store) as unknown as AcknowledgeWithReceipts;
  return claims === undefined ? fn(target, messageIds, nowMs) : fn(target, messageIds, nowMs, claims);
}

afterEach(() => {
  vi.restoreAllMocks();
  const cleanupErrors: unknown[] = [];
  while (resources.length > 0) {
    const resource = resources.pop()!;
    while (resource.auxDbs.length > 0) {
      const entry = resource.auxDbs.pop()!;
      if (!entry.closed) {
        try {
          entry.db.close();
          entry.closed = true;
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
    if (!resource.storeClosed) {
      try {
        resource.store.close();
        resource.storeClosed = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      rmSync(resource.dir, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length === 1) {
    throw cleanupErrors[0];
  }
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "Failed to clean up test store resources.");
  }
});

describe("AGS-D-0354 claim-owner-late-ack-r01 regression suite", () => {
  it("baseline 4df counterexample: A claims -> lease expires -> B reclaims -> A late id-only ACK returns 0 and does not close B's active claim", () => {
    const { store } = createTempStore();
    const sender = { host: "codex", sessionId: "sender-d0354-baseline" };
    const target = { host: "antigravity", sessionId: "target-d0354-baseline" };
    const t0 = Date.parse("2026-10-30T06:00:00.000Z");
    setSystemNow(t0);

    const prepared = store.prepare(
      {
        sender,
        target,
        body: "D-0354 baseline counterexample payload",
        ttlSeconds: 3600,
      },
      t0,
    );
    store.submitPrepared(sender, prepared.messageId, t0 + 10);

    // 1. A가 본문 인수 (deliveryAttempt = 1, 임대 120,000ms)
    const tClaimA = t0 + 20;
    setSystemNow(tClaimA);
    const firstClaim = store.claim(target, tClaimA);
    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0]!.messageId).toBe(prepared.messageId);
    expect(firstClaim[0]!.deliveryAttempt).toBe(1);

    // 2. 첫 번째 인수 임대(120,000ms) 만료 후 B가 재인수 (deliveryAttempt = 2, 임대 240,000ms)
    const tReclaimB = tClaimA + claimLeaseMs(1) + 1;
    setSystemNow(tReclaimB);
    const secondClaim = store.claim(target, tReclaimB);
    expect(secondClaim).toHaveLength(1);
    expect(secondClaim[0]!.messageId).toBe(prepared.messageId);
    expect(secondClaim[0]!.deliveryAttempt).toBe(2);

    // 3. B 재인수 뒤 A의 늦은 ACK 시도 (새 필드/새 컬럼 단언 없이 4df 공개 계약만으로 실행):
    //    4dfc6162에서는 1을 반환하며 B의 활성 인수를 닫아버리고, 수리 후에는 0을 반환하며 delivered 상태를 보존함.
    const tLateAckA = tReclaimB + 5_000;
    setSystemNow(tLateAckA);
    const lateAckByStaleOwnerA = store.acknowledge(target, [prepared.messageId], tLateAckA);
    expect(lateAckByStaleOwnerA).toBe(0);
    expect(store.status(sender, prepared.messageId, tLateAckA)?.state).toBe("delivered");
  });

  it("post-repair receipt contract: rejects stale claim owner receipt after B reclaims while preserving message body, claim_receipt, and session_activity until B ACKs with B's receipt", () => {
    const { store, openInspectorDb } = createTempStore();
    const sender = { host: "codex", sessionId: "sender-d0354-main" };
    const target = { host: "antigravity", sessionId: "target-d0354-shared-session" };
    const t0 = Date.parse("2026-10-30T06:00:00.000Z");
    setSystemNow(t0);

    const prepared = store.prepare(
      {
        sender,
        target,
        body: "D-0354 atomic claim receipt ownership payload",
        ttlSeconds: 3600,
      },
      t0,
    );
    store.submitPrepared(sender, prepared.messageId, t0 + 10);

    const tClaimA = t0 + 20;
    setSystemNow(tClaimA);
    const firstClaim = store.claim(target, tClaimA) as ClaimedMessageWithReceipt[];
    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0]!.deliveryAttempt).toBe(1);
    const receiptA = firstClaim[0]!.claimReceipt;
    expect(typeof receiptA).toBe("string");

    const tReclaimB = tClaimA + claimLeaseMs(1) + 1;
    setSystemNow(tReclaimB);
    const secondClaim = store.claim(target, tReclaimB) as ClaimedMessageWithReceipt[];
    expect(secondClaim).toHaveLength(1);
    expect(secondClaim[0]!.deliveryAttempt).toBe(2);
    const receiptB = secondClaim[0]!.claimReceipt;
    expect(typeof receiptB).toBe("string");
    expect(receiptB).not.toBe(receiptA);

    const db = openInspectorDb();
    const beforeLateAckRow = db
      .prepare("SELECT body, claim_receipt, claim_until, acknowledged_at FROM messages WHERE message_id = ?")
      .get(prepared.messageId) as {
      body: string;
      claim_receipt: string | null;
      claim_until: string | null;
      acknowledged_at: string | null;
    };
    const activityBeforeLateAck = db
      .prepare("SELECT active_at FROM session_activity WHERE host = ? AND session_id = ?")
      .get(target.host, target.sessionId) as { active_at: string } | undefined;
    expect(activityBeforeLateAck?.active_at).toBe(new Date(tReclaimB).toISOString());

    // B 재인수 뒤 A의 원회차 영수증(receiptA) 및 id-only, broker receipts 호출 모두 0 반환
    const tLateAckA = tReclaimB + 5_000;
    setSystemNow(tLateAckA);
    expect(acknowledgeStore(store, target, [prepared.messageId], tLateAckA)).toBe(0);
    expect(
      acknowledgeStore(store, target, [prepared.messageId], tLateAckA, [
        { messageId: prepared.messageId, claimReceipt: receiptA! },
      ]),
    ).toBe(0);

    const brokerLateAckA = dispatchSessionMessageBrokerOperation(store, "acknowledge", {
      target,
      messageIds: [prepared.messageId],
      receipts: [{ messageId: prepared.messageId, claimReceipt: receiptA! }],
    }) as { acknowledged: number };
    expect(brokerLateAckA.acknowledged).toBe(0);

    // 거부 후 본문(body), 영수증(claim_receipt), 임대(claim_until), acknowledged_at, 활동(session_activity.active_at) 불변 검증
    const afterLateAckRow = db
      .prepare("SELECT body, claim_receipt, claim_until, acknowledged_at FROM messages WHERE message_id = ?")
      .get(prepared.messageId) as {
      body: string;
      claim_receipt: string | null;
      claim_until: string | null;
      acknowledged_at: string | null;
    };
    const activityAfterLateAck = db
      .prepare("SELECT active_at FROM session_activity WHERE host = ? AND session_id = ?")
      .get(target.host, target.sessionId) as { active_at: string } | undefined;

    expect(afterLateAckRow).toEqual(beforeLateAckRow);
    expect(afterLateAckRow.body).toBe("D-0354 atomic claim receipt ownership payload");
    expect(afterLateAckRow.claim_receipt).toBe(receiptB);
    expect(afterLateAckRow.acknowledged_at).toBeNull();
    expect(activityAfterLateAck?.active_at).toBe(activityBeforeLateAck?.active_at);
    expect(store.status(sender, prepared.messageId, tLateAckA)?.state).toBe("delivered");

    // B의 원회차 영수증(receiptB)으로 정상 ACK 시 1 반환 및 상태·활동 갱신
    const tAckB = tLateAckA + 1_000;
    setSystemNow(tAckB);
    expect(
      acknowledgeStore(store, target, [prepared.messageId], tAckB, [
        { messageId: prepared.messageId, claimReceipt: receiptB! },
      ]),
    ).toBe(1);
    expect(store.status(sender, prepared.messageId, tAckB)?.state).toBe("acknowledged");
    const activityAfterAckB = db
      .prepare("SELECT active_at FROM session_activity WHERE host = ? AND session_id = ?")
      .get(target.host, target.sessionId) as { active_at: string } | undefined;
    expect(activityAfterAckB?.active_at).toBe(new Date(tAckB).toISOString());
  });

  it("post-repair receipt contract: rejects cross-epoch receipts within the same process (respecting 120000ms and 240000ms backoff leases) and rejects foreign message receipts", () => {
    const { store } = createTempStore();
    const sender = { host: "codex", sessionId: "sender-d0354-same-proc" };
    const target = { host: "codex", sessionId: "target-d0354-same-proc" };
    const t0 = Date.parse("2026-10-30T06:10:00.000Z");
    setSystemNow(t0);

    const msg1 = store.prepare({ sender, target, body: "message-epoch-target", ttlSeconds: 3600 }, t0);
    const msg2 = store.prepare({ sender, target, body: "message-other-target", ttlSeconds: 3600 }, t0);
    store.submitPrepared(sender, msg1.messageId, t0 + 5);

    // 1차 인수: deliveryAttempt = 1, lease = 120,000ms
    const tEpoch1 = t0 + 10;
    setSystemNow(tEpoch1);
    const claimEpoch1 = (store.claim(target, tEpoch1) as ClaimedMessageWithReceipt[])[0]!;
    const receiptEpoch1 = claimEpoch1.claimReceipt!;
    expect(claimEpoch1.deliveryAttempt).toBe(1);
    expect(typeof receiptEpoch1).toBe("string");

    // 2차 인수: 1차 임대(120,000ms) 만료 후, deliveryAttempt = 2, lease = 240,000ms
    const tEpoch2 = tEpoch1 + claimLeaseMs(1) + 1;
    setSystemNow(tEpoch2);
    const claimEpoch2 = (store.claim(target, tEpoch2) as ClaimedMessageWithReceipt[])[0]!;
    const receiptEpoch2 = claimEpoch2.claimReceipt!;
    expect(claimEpoch2.deliveryAttempt).toBe(2);
    expect(typeof receiptEpoch2).toBe("string");
    expect(receiptEpoch2).not.toBe(receiptEpoch1);

    // 3차 인수: 2차 임대(240,000ms) 만료 후, deliveryAttempt = 3, lease = 480,000ms
    const tEpoch3 = tEpoch2 + claimLeaseMs(2) + 1;
    setSystemNow(tEpoch3);
    const claimEpoch3 = (store.claim(target, tEpoch3) as ClaimedMessageWithReceipt[])[0]!;
    const receiptEpoch3 = claimEpoch3.claimReceipt!;
    expect(claimEpoch3.deliveryAttempt).toBe(3);
    expect(typeof receiptEpoch3).toBe("string");
    expect(receiptEpoch3).not.toBe(receiptEpoch2);

    // 같은 프로세스에서 다른 메시지(msg2) 인수 영수증 확보
    store.submitPrepared(sender, msg2.messageId, tEpoch3 + 5);
    setSystemNow(tEpoch3 + 10);
    const claimOther = (store.claim(target, tEpoch3 + 10) as ClaimedMessageWithReceipt[]).find(
      (m) => m.messageId === msg2.messageId,
    )!;
    const receiptOther = claimOther.claimReceipt!;
    expect(typeof receiptOther).toBe("string");

    // 같은 프로세스의 이전 회차(epoch 1, epoch 2) 및 다른 메시지 영수증 모두 거부(0)
    setSystemNow(tEpoch3 + 20);
    expect(
      acknowledgeStore(store, target, [msg1.messageId], tEpoch3 + 20, [
        { messageId: msg1.messageId, claimReceipt: receiptEpoch1 },
      ]),
    ).toBe(0);
    expect(
      acknowledgeStore(store, target, [msg1.messageId], tEpoch3 + 21, [
        { messageId: msg1.messageId, claimReceipt: receiptEpoch2 },
      ]),
    ).toBe(0);
    expect(
      acknowledgeStore(store, target, [msg1.messageId], tEpoch3 + 22, [
        { messageId: msg1.messageId, claimReceipt: receiptOther },
      ]),
    ).toBe(0);

    // 현재 회차(epoch 3) 영수증만 승인(1)
    setSystemNow(tEpoch3 + 25);
    expect(
      acknowledgeStore(store, target, [msg1.messageId], tEpoch3 + 25, [
        { messageId: msg1.messageId, claimReceipt: receiptEpoch3 },
      ]),
    ).toBe(1);
  });

  it("post-repair receipt contract: allows late ACK by the original claim owner after lease expiry when not reclaimed and keeps duplicate ACKs idempotent with 0", () => {
    const { store } = createTempStore();
    const sender = { host: "codex", sessionId: "sender-d0354-late-owner" };
    const target = { host: "antigravity", sessionId: "target-d0354-late-owner" };
    const t0 = Date.parse("2026-10-30T06:20:00.000Z");
    setSystemNow(t0);

    const prepared = store.prepare(
      {
        sender,
        target,
        body: "late-ack-without-reclaim",
        ttlSeconds: 3600,
      },
      t0,
    );
    store.submitPrepared(sender, prepared.messageId, t0 + 10);

    const tClaim = t0 + 20;
    setSystemNow(tClaim);
    const claimed = (store.claim(target, tClaim) as ClaimedMessageWithReceipt[])[0]!;
    const receipt = claimed.claimReceipt!;
    expect(typeof receipt).toBe("string");

    // 재인수 없이 1차 임대(120,000ms) 만료 경과
    const tAfterLeaseExpiry = tClaim + claimLeaseMs(1) + 500;
    setSystemNow(tAfterLeaseExpiry);

    // 새 claim 행은 재인수 전이라도 영수증 없는 id-only ACK 거부(0)
    expect(acknowledgeStore(store, target, [prepared.messageId], tAfterLeaseExpiry, [])).toBe(0);

    // 임대 기한 만료는 ACK 거부 조건이 아니므로 원소유자의 원회차 영수증 늦은 정상 ACK는 1
    const tValidLateAck = tAfterLeaseExpiry + 10;
    setSystemNow(tValidLateAck);
    expect(
      acknowledgeStore(store, target, [prepared.messageId], tValidLateAck, [
        { messageId: prepared.messageId, claimReceipt: receipt },
      ]),
    ).toBe(1);
    expect(store.status(sender, prepared.messageId, tValidLateAck)?.state).toBe("acknowledged");

    // 동일 영수증 중복 ACK는 store 및 broker 모두 에러 없이 멱등 0
    const tDuplicateAck = tValidLateAck + 10;
    setSystemNow(tDuplicateAck);
    expect(
      acknowledgeStore(store, target, [prepared.messageId], tDuplicateAck, [
        { messageId: prepared.messageId, claimReceipt: receipt },
      ]),
    ).toBe(0);
    const brokerDuplicate = dispatchSessionMessageBrokerOperation(store, "acknowledge", {
      target,
      messageIds: [prepared.messageId],
      receipts: [{ messageId: prepared.messageId, claimReceipt: receipt }],
    }) as { acknowledged: number };
    expect(brokerDuplicate.acknowledged).toBe(0);
  });

  it("post-repair receipt contract: rejects ACK from a mismatched target even when presenting the valid current claimReceipt", () => {
    const { store, openInspectorDb } = createTempStore();
    const sender = { host: "codex", sessionId: "sender-d0354-target-check" };
    const target = { host: "antigravity", sessionId: "target-d0354-owner" };
    const otherSessionTarget = { host: "antigravity", sessionId: "target-d0354-other" };
    const otherHostTarget = { host: "codex", sessionId: "target-d0354-owner" };
    const t0 = Date.parse("2026-10-30T06:25:00.000Z");
    setSystemNow(t0);

    const prepared = store.prepare({ sender, target, body: "target-isolation-check", ttlSeconds: 3600 }, t0);
    store.submitPrepared(sender, prepared.messageId, t0 + 10);

    const tClaim = t0 + 20;
    setSystemNow(tClaim);
    const claimed = (store.claim(target, tClaim) as ClaimedMessageWithReceipt[])[0]!;
    const receipt = claimed.claimReceipt!;
    expect(typeof receipt).toBe("string");

    const db = openInspectorDb();
    const activityBefore = db
      .prepare("SELECT active_at FROM session_activity WHERE host = ? AND session_id = ?")
      .get(target.host, target.sessionId) as { active_at: string } | undefined;

    // 이종 target(다른 sessionId 또는 다른 host)이 유효한 claimReceipt를 제시해도 거부(0)
    setSystemNow(t0 + 100);
    expect(
      acknowledgeStore(store, otherSessionTarget, [prepared.messageId], t0 + 100, [
        { messageId: prepared.messageId, claimReceipt: receipt },
      ]),
    ).toBe(0);
    setSystemNow(t0 + 110);
    expect(
      acknowledgeStore(store, otherHostTarget, [prepared.messageId], t0 + 110, [
        { messageId: prepared.messageId, claimReceipt: receipt },
      ]),
    ).toBe(0);
    setSystemNow(t0 + 120);
    const brokerMismatched = dispatchSessionMessageBrokerOperation(store, "acknowledge", {
      target: otherSessionTarget,
      messageIds: [prepared.messageId],
      receipts: [{ messageId: prepared.messageId, claimReceipt: receipt }],
    }) as { acknowledged: number };
    expect(brokerMismatched.acknowledged).toBe(0);

    const row = db
      .prepare("SELECT body, claim_receipt, acknowledged_at FROM messages WHERE message_id = ?")
      .get(prepared.messageId) as { body: string; claim_receipt: string | null; acknowledged_at: string | null };
    const activityAfter = db
      .prepare("SELECT active_at FROM session_activity WHERE host = ? AND session_id = ?")
      .get(target.host, target.sessionId) as { active_at: string } | undefined;
    expect(row.body).toBe("target-isolation-check");
    expect(row.claim_receipt).toBe(receipt);
    expect(row.acknowledged_at).toBeNull();
    expect(activityAfter?.active_at).toBe(activityBefore?.active_at);

    // 본래 target으로 ACK 시 1
    setSystemNow(t0 + 200);
    expect(
      acknowledgeStore(store, target, [prepared.messageId], t0 + 200, [
        { messageId: prepared.messageId, claimReceipt: receipt },
      ]),
    ).toBe(1);
  });

  it("post-repair receipt contract: preserves id-only ACK only for legacy NULL claim_receipt rows, enforces receipts on mixed batches (id-only 0 for new claims), and upgrades legacy NULL rows on first reclaim", () => {
    const { store, openInspectorDb } = createTempStore();
    const sender = { host: "codex", sessionId: "sender-d0354-legacy-mixed" };
    const target = { host: "antigravity", sessionId: "target-d0354-legacy-mixed" };
    const t0 = Date.parse("2026-10-30T06:30:00.000Z");
    setSystemNow(t0);

    const legacyDirect = store.prepare({ sender, target, body: "legacy-null-direct-ack", ttlSeconds: 3600 }, t0);
    const legacyReclaim = store.prepare({ sender, target, body: "legacy-null-reclaim-upgrade", ttlSeconds: 3600 }, t0);
    const newMsg1 = store.prepare({ sender, target, body: "new-claim-msg-1", ttlSeconds: 3600 }, t0);
    const newMsg2 = store.prepare({ sender, target, body: "new-claim-msg-2", ttlSeconds: 3600 }, t0);

    store.submitPrepared(sender, legacyDirect.messageId, t0 + 1);
    store.submitPrepared(sender, legacyReclaim.messageId, t0 + 2);
    store.submitPrepared(sender, newMsg1.messageId, t0 + 3);
    store.submitPrepared(sender, newMsg2.messageId, t0 + 4);

    const tClaim1 = t0 + 20;
    setSystemNow(tClaim1);
    const claimedBatch = store.claim(target, tClaim1, { maxMessages: 10 }) as ClaimedMessageWithReceipt[];
    expect(claimedBatch).toHaveLength(4);

    const receiptNew1 = claimedBatch.find((m) => m.messageId === newMsg1.messageId)!.claimReceipt!;
    const receiptNew2 = claimedBatch.find((m) => m.messageId === newMsg2.messageId)!.claimReceipt!;
    expect(typeof receiptNew1).toBe("string");
    expect(typeof receiptNew2).toBe("string");

    const db = openInspectorDb();
    // 최초 v1→v2 이전과 동등한 역사 상태를 명시한다. 이전 당시 원회차만 NULL 영수증 상한으로 보존한다.
    db.prepare("UPDATE messages SET legacy_claim_attempt = delivery_attempts, claim_receipt = NULL WHERE message_id IN (?, ?)").run(
      legacyDirect.messageId,
      legacyReclaim.messageId,
    );

    // 1) 새 claim 행들로만 구성된 복수 배치에서 id-only(receipts 없음) 호출 시 0
    setSystemNow(tClaim1 + 10);
    expect(acknowledgeStore(store, target, [newMsg1.messageId, newMsg2.messageId], tClaim1 + 10, [])).toBe(0);
    const brokerNewBatchIdOnly = dispatchSessionMessageBrokerOperation(store, "acknowledge", {
      target,
      messageIds: [newMsg1.messageId, newMsg2.messageId],
    }) as { acknowledged: number };
    expect(brokerNewBatchIdOnly.acknowledged).toBe(0);

    // 2) 새 claim 행 2개 중 newMsg1만 영수증을 제공하고 newMsg2는 id-only로 혼합 호출하면 newMsg1만 1건 ACK되고 newMsg2(id-only)는 0(미승인)
    setSystemNow(tClaim1 + 20);
    expect(
      acknowledgeStore(store, target, [newMsg1.messageId, newMsg2.messageId], tClaim1 + 20, [
        { messageId: newMsg1.messageId, claimReceipt: receiptNew1 },
      ]),
    ).toBe(1);
    expect(store.status(sender, newMsg1.messageId, tClaim1 + 20)?.state).toBe("acknowledged");
    expect(store.status(sender, newMsg2.messageId, tClaim1 + 20)?.state).toBe("delivered");

    // 3) 역사 NULL 행(legacyDirect)은 id-only 유지(1), 함께 넣은 새 claim 행(newMsg2)은 id-only 거부(미승인 유지)
    setSystemNow(tClaim1 + 30);
    expect(acknowledgeStore(store, target, [legacyDirect.messageId, newMsg2.messageId], tClaim1 + 30, [])).toBe(1);
    expect(store.status(sender, legacyDirect.messageId, tClaim1 + 30)?.state).toBe("acknowledged");
    expect(store.status(sender, newMsg2.messageId, tClaim1 + 30)?.state).toBe("delivered");

    // 4) 역사 NULL 행(legacyReclaim)도 1차 임대(120,000ms) 만료 후 최초 재인수(claim)부터는 새 claimReceipt가 부여되어 id-only ACK가 0으로 거부됨
    const tReclaim = tClaim1 + claimLeaseMs(1) + 5;
    setSystemNow(tReclaim);
    const reclaimed = store.claim(target, tReclaim, { maxMessages: 10 }) as ClaimedMessageWithReceipt[];
    const reclaimedLegacy = reclaimed.find((m) => m.messageId === legacyReclaim.messageId)!;
    const reclaimedNew2 = reclaimed.find((m) => m.messageId === newMsg2.messageId)!;
    expect(reclaimedLegacy).toBeDefined();
    expect(typeof reclaimedLegacy.claimReceipt).toBe("string");
    expect(reclaimedNew2).toBeDefined();
    expect(typeof reclaimedNew2.claimReceipt).toBe("string");
    expect(reclaimedNew2.claimReceipt).not.toBe(receiptNew2);

    // 최초 재인수 후 역사 행에 대해 id-only 호출 시 0 (영수증 필수 전환 확인)
    setSystemNow(tReclaim + 10);
    expect(acknowledgeStore(store, target, [legacyReclaim.messageId], tReclaim + 10, [])).toBe(0);

    // 재인수 영수증을 제시해야만 정상 ACK
    setSystemNow(tReclaim + 20);
    const brokerFinalAck = dispatchSessionMessageBrokerOperation(store, "acknowledge", {
      target,
      messageIds: [legacyReclaim.messageId, newMsg2.messageId],
      receipts: [
        { messageId: legacyReclaim.messageId, claimReceipt: reclaimedLegacy.claimReceipt! },
        { messageId: newMsg2.messageId, claimReceipt: reclaimedNew2.claimReceipt! },
      ],
    }) as { acknowledged: number };
    expect(brokerFinalAck.acknowledged).toBe(2);
    expect(store.status(sender, legacyReclaim.messageId, tReclaim + 20)?.state).toBe("acknowledged");
    expect(store.status(sender, newMsg2.messageId, tReclaim + 20)?.state).toBe("acknowledged");
  });
});
