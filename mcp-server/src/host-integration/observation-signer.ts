import { randomBytes } from "node:crypto";

import { RoutingObservationSigner, type RoutingObserverReceipt } from "../../../skills/coordinate-subagents/scripts/model-routing-store.mjs";
import type { WorkflowStore } from "../workflow-store.js";
import {
  ObservationChallengeAuthority, type HostObservationReader, type ObservationChallengeBodyV1,
} from "./observation-challenge.js";

export interface ObservationReceiptBodyV1 {
  version: 1;
  domain: "host-observation-receipt" | "test-observation-receipt";
  challenge: ObservationChallengeBodyV1;
}

export type ObservationReceiptV1 = RoutingObserverReceipt & {
  kind: "observation";
  payload: ObservationReceiptBodyV1;
};

/** Signs only a consumed V03 challenge; neither source labels nor caller model fields are inputs. */
export class ObservationReceiptSigner {
  private readonly challenge: ObservationChallengeAuthority;
  private readonly signer: RoutingObservationSigner;

  constructor(
    store: WorkflowStore,
    reader: HostObservationReader,
    private readonly domain: "host" | "test",
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.challenge = new ObservationChallengeAuthority(store, reader, domain, clock);
    const key = Buffer.from(store.getOrCreateSecret(
      `${domain}_observation_receipt_v1`, () => randomBytes(32).toString("base64url"),
    ), "base64url");
    if (key.length !== 32) throw new Error("Stored observation receipt key is invalid.");
    this.signer = new RoutingObservationSigner(key);
  }

  issueChallenge(): string { return this.challenge.issue(); }

  sign(challengeToken: string): ObservationReceiptV1 {
    const now = this.clock();
    if (!Number.isFinite(now.getTime())) throw new Error("Observation receipt clock is invalid.");
    const challenge = this.challenge.verifyAndConsume(challengeToken);
    if (challenge.domain !== this.domain || now.getTime() < Date.parse(challenge.issuedAt)
      || now.getTime() >= Date.parse(challenge.expiresAt)) {
      throw new Error("Observation challenge domain or lifetime is invalid.");
    }
    const payload: ObservationReceiptBodyV1 = {
      version: 1,
      domain: this.domain === "host" ? "host-observation-receipt" : "test-observation-receipt",
      challenge,
    };
    return this.signer.issue("observation", payload, {
      issuedAt: now.toISOString(), expiresAt: challenge.expiresAt,
    }) as ObservationReceiptV1;
  }
}
