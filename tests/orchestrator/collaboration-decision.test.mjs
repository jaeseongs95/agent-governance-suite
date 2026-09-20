import { describe, expect, it } from "vitest";

import { deriveCollaborationRoute, validateCollaborationDecision } from "../../skills/orchestrator/scripts/collaboration-decision.mjs";

const base = () => ({
  schemaVersion: "1.0.0",
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
    audit.route = "audit-only";
    expect(deriveCollaborationRoute(audit)).toBe("audit-only");
    expect(validateCollaborationDecision(audit)).toEqual([]);
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
