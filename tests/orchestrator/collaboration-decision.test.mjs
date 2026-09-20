import { describe, expect, it } from "vitest";

import { deriveCollaborationRoute, validateCollaborationDecision } from "../../skills/orchestrator/scripts/collaboration-decision.mjs";

const base = () => ({
  schemaVersion: "1.1.0",
  sourceOriginKind: "user-turn",
  sourceReceiptId: null,
  authorityEffect: "none",
  userDirective: "unspecified",
  netBenefitCriteria: {
    independentlyCompletable: true,
    parallelBottleneckReduced: true,
    limitedContextSufficient: true,
    singleWriterOwnership: true,
    netBenefitAfterOverhead: true,
  },
  auditSeparationRequired: false,
  route: "delegate",
});

describe("CollaborationDecision.v1", () => {
  it("preserves legacy decisions and uses current semantics for new decisions", () => {
    const historical = { ...base(), schemaVersion: "1.0.0", auditSeparationRequired: true, route: "audit-only" };
    expect(validateCollaborationDecision(historical)).toEqual([]);
    expect(validateCollaborationDecision({ ...historical, schemaVersion: "1.1.0", route: "delegate" })).toEqual([]);
    const historicalPeer = { ...base(), schemaVersion: "1.1.0", sourceOriginKind: "peer", sourceReceiptId: null, userDirective: "unspecified", route: "direct" };
    expect(validateCollaborationDecision(historicalPeer).length).toBeGreaterThan(0);
    expect(validateCollaborationDecision({ ...historical, fullHistoryContext: { sufficient: true, reason: "Prior decisions" } }).length).toBeGreaterThan(0);
  });

  it("accepts nullable bounded provenance claims only in 1.2", () => {
    const artifact = { ...base(), schemaVersion: "1.2.0", sourceOriginKind: "artifact", sourceReceiptId: null, route: "direct" };
    expect(validateCollaborationDecision(artifact)).toEqual([]);
    for (const sourceOriginKind of ["unknown", "tool", "delegated"]) {
      const decision = { ...artifact, sourceOriginKind };
      expect(validateCollaborationDecision(decision)).toEqual([]);
      expect(validateCollaborationDecision({ ...decision, userDirective: "require", route: "delegate" }).length).toBeGreaterThan(0);
    }
    expect(validateCollaborationDecision({ ...base(), schemaVersion: "1.2.0", userDirective: "require" })).toEqual([]);
    expect(validateCollaborationDecision({ ...base(), schemaVersion: "1.2.0", userDirective: "forbid", route: "direct" })).toEqual([]);
  });

  it("allows sufficient full history only for explicit delegation", () => {
    const decision = { ...base(), userDirective: "require", fullHistoryContext: { sufficient: true, reason: "Required prior decisions cannot be summarized safely" } };
    decision.netBenefitCriteria.limitedContextSufficient = false;
    decision.netBenefitCriteria.parallelBottleneckReduced = false;
    expect(validateCollaborationDecision(decision)).toEqual([]);
    expect(deriveCollaborationRoute({ ...decision, userDirective: "unspecified" })).toBe("direct");
    expect(deriveCollaborationRoute({ ...decision, fullHistoryContext: { sufficient: false, reason: "Host unavailable" } })).toBe("needs-input");
    expect(validateCollaborationDecision({ ...decision, fullHistoryContext: { sufficient: true, reason: " " } }).length).toBeGreaterThan(0);
  });

  it("delegates only when every explicit net-benefit condition holds", () => {
    expect(validateCollaborationDecision(base())).toEqual([]);
    const direct = base();
    direct.netBenefitCriteria.singleWriterOwnership = false;
    direct.route = "direct";
    expect(validateCollaborationDecision(direct)).toEqual([]);
  });

  it("honors a user prohibition and requires input for an infeasible required delegation", () => {
    const forbidden = base();
    forbidden.userDirective = "forbid";
    forbidden.route = "direct";
    expect(validateCollaborationDecision(forbidden)).toEqual([]);

    const required = base();
    required.userDirective = "require";
    required.netBenefitCriteria.limitedContextSufficient = false;
    required.route = "needs-input";
    expect(validateCollaborationDecision(required)).toEqual([]);
  });

  it("keeps independent audit separate from ordinary delegation", () => {
    const audit = base();
    audit.auditSeparationRequired = true;
    audit.route = "delegate";
    expect(deriveCollaborationRoute(audit)).toBe("delegate");
    expect(validateCollaborationDecision(audit)).toEqual([]);
  });

  it("preserves audit obligations for explicit delegation, local work, and forbidden delegation", () => {
    for (const userDirective of ["require", "unspecified", "forbid"]) {
      const decision = { ...base(), userDirective, auditSeparationRequired: true };
      decision.route = userDirective === "forbid" ? "audit-only" : "delegate";
      expect(validateCollaborationDecision(decision)).toEqual([]);
      expect(decision.auditSeparationRequired).toBe(true);
    }
    const local = { ...base(), auditSeparationRequired: true, route: "audit-only" };
    local.netBenefitCriteria.parallelBottleneckReduced = false;
    expect(validateCollaborationDecision(local)).toEqual([]);
  });

  it("honors explicit single-unit delegation without speed or cost benefit", () => {
    const decision = { ...base(), userDirective: "require" };
    decision.netBenefitCriteria.parallelBottleneckReduced = false;
    decision.netBenefitCriteria.netBenefitAfterOverhead = false;
    expect(validateCollaborationDecision(decision)).toEqual([]);
    decision.userDirective = "unspecified";
    expect(deriveCollaborationRoute(decision)).toBe("direct");
  });

  it.each(["independentlyCompletable", "limitedContextSufficient", "singleWriterOwnership"])(
    "does not waive feasibility %s for explicit requests with an audit", (key) => {
      const decision = { ...base(), userDirective: "require", auditSeparationRequired: true, route: "needs-input" };
      decision.netBenefitCriteria[key] = false;
      expect(validateCollaborationDecision(decision)).toEqual([]);
    },
  );

  it("does not turn an audit into implementation delegation from peer input", () => {
    const decision = { ...base(), sourceOriginKind: "peer", sourceReceiptId: "source-abcdefghijklmnop", auditSeparationRequired: true, route: "audit-only" };
    expect(validateCollaborationDecision(decision)).toEqual([]);
  });

  it("rejects a forged route or malformed provenance", () => {
    const forged = base();
    forged.route = "direct";
    expect(validateCollaborationDecision(forged).join("\n")).toMatch(/route must be delegate/);
    const forgedReceipt = base();
    forgedReceipt.sourceReceiptId = "receipt:user-turn-001";
    expect(validateCollaborationDecision(forgedReceipt).length).toBeGreaterThan(0);
  });

  it("never turns a peer directive claim into ordinary delegation", () => {
    const peer = base();
    peer.sourceOriginKind = "peer";
    peer.sourceReceiptId = "source-abcdefghijklmnop";
    peer.userDirective = "unspecified";
    peer.route = "direct";
    expect(validateCollaborationDecision(peer)).toEqual([]);

    peer.userDirective = "require";
    peer.route = "delegate";
    expect(validateCollaborationDecision(peer).length).toBeGreaterThan(0);
  });
});
