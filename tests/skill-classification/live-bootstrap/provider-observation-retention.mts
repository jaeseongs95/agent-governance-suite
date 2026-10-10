import assert from "node:assert/strict";
import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {setImmediate as nextTurn} from "node:timers/promises";
import {bindMockAuthorityAndEvidence, mockEnv, mockResponse, readyMock} from "./prepared-fixture.mjs";

type Api = typeof import("./bootstrap.mts");
type Body = {model: string; answers: Record<string, {type: string; noul: unknown}>; usage: {input_tokens: number; output_tokens: number}};
type Usage = {inputTokens: number | null; outputTokens: number | null; actualCostUsd: number | null};
type Raw = {response: unknown; usage: Usage; errorCode: string | null; transportAttempts: number;
  costAccounting: {unknownReservedUsd: number};
  providerObservation: {rawBody: string | null; usage: Usage; partial: boolean; omissionReason: string | null; byteCount?: number} | null};
type Entry = {state: string; actualCostUsd: number | null; reservedUsd: number};
type Case = {id: string; error?: string | null; omission: string | null; knownUsage: boolean; partial: boolean; keepRaw: boolean};
const cases: Case[] = [
  {id: "success", error: null, omission: null, knownUsage: true, partial: false, keepRaw: true},
  {id: "http500", error: "API_UNAVAILABLE", omission: null, knownUsage: true, partial: false, keepRaw: true},
  {id: "revoked-after-fetch", error: "CURRENT_AUTHORITY_OR_RESERVATION_CHANGED", omission: null, knownUsage: true, partial: false, keepRaw: true},
  {id: "safe-chunk-read-error", error: "TRANSPORT_UNAVAILABLE", omission: null, knownUsage: true, partial: true, keepRaw: true},
  {id: "truncated-read-error", error: "TRANSPORT_UNAVAILABLE", omission: "UNINSPECTABLE_BODY", knownUsage: false, partial: true, keepRaw: false},
  {id: "invalid-score", error: "INVALID_PROVIDER_RESPONSE", omission: "BODY_OUTSIDE_SAFE_JEV_CONTRACT", knownUsage: true, partial: false, keepRaw: false},
  {id: "escaped-credential", omission: "UNSAFE_OR_AMBIGUOUS_BODY", knownUsage: false, partial: false, keepRaw: false},
  {id: "endpoint-echo", omission: "UNSAFE_OR_AMBIGUOUS_BODY", knownUsage: false, partial: false, keepRaw: false},
  {id: "overwritten-secret", omission: "UNSAFE_OR_AMBIGUOUS_BODY", knownUsage: false, partial: false, keepRaw: false},
  {id: "byte-cap", error: "PROVIDER_RESPONSE_TOO_LARGE", omission: "UNINSPECTABLE_BODY", knownUsage: false, partial: true, keepRaw: false},
  {id: "invalid-utf8", error: "INVALID_PROVIDER_RESPONSE", omission: "UNINSPECTABLE_BODY", knownUsage: false, partial: true, keepRaw: false},
  {id: "invalid-json", error: "INVALID_PROVIDER_RESPONSE", omission: "UNINSPECTABLE_BODY", knownUsage: false, partial: false, keepRaw: false},
  {id: "timeout-safe-chunk", error: "DISPATCH_TIMEOUT_UNKNOWN", omission: null, knownUsage: true, partial: true, keepRaw: true},
];
const escapedString = (text: string) => '"' + [...text].map(char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0")).join("") + '"';

/** Caller owns a fresh temporary root and its cleanup. No import-time execution or real provider call. */
export async function checkProviderObservationRetention(api: Api, repo: string, root: string): Promise<string[]> {
  const checked: string[] = [];
  for (const spec of cases) {
    const output = path.join(root, "retention-" + spec.id);
    const {config, prepared} = await readyMock(api, repo, output, "retention-" + spec.id, {requests: 1,
      ...(spec.id === "timeout-safe-chunk" ? {timeoutMs: 30000} : {})});
    if (spec.id === "byte-cap") {
      config.limits!.responseBytes = 32;
      await bindMockAuthorityAndEvidence(api, config);
    }
    let calls = 0, cancellations = 0, deliveredBody = "";
    const pending: {release?: () => void; reached: boolean} = {reached: false};
    const nativeSetTimeout = globalThis.setTimeout;
    const abortCallbacks: (() => void)[] = [];
    const fallbackTimers: ReturnType<typeof nativeSetTimeout>[] = [];
    let controlledAbortTriggered = false, abortInvocations = 0;
    let actualSignal: AbortSignal | undefined;
    if (spec.id === "timeout-safe-chunk") {
      // The 30s ceiling is a fallback only; second pending pull drives the real abort callback.
      globalThis.setTimeout = Object.assign((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
        if (delay !== config.limits!.timeoutMs) return nativeSetTimeout(callback, delay, ...args);
        const realAbort = () => {abortInvocations++; callback(...args);};
        abortCallbacks.push(realAbort);
        const timer = nativeSetTimeout(realAbort, 30000);
        fallbackTimers.push(timer);
        return timer;
      }, nativeSetTimeout);
    }
    const fetcher: typeof fetch = async (_url, init) => {
      calls++;
      actualSignal = init?.signal ?? undefined;
      const body = await mockResponse(init).json() as Body;
      body.usage = {input_tokens: 37, output_tokens: 7};
      deliveredBody = JSON.stringify(body);
      if (spec.id === "revoked-after-fetch") {
        const authorityFile = path.join(output, config.currentAuthority!.reference.path);
        const authority = JSON.parse(await readFile(authorityFile, "utf8")) as {approved: boolean};
        authority.approved = false;
        await writeFile(authorityFile, JSON.stringify(authority));
      }
      if (spec.id === "invalid-score") {
        body.answers[Object.keys(body.answers)[0]!]!.noul = "not-a-number";
        deliveredBody = JSON.stringify(body);
      }
      if (spec.id === "escaped-credential") {
        deliveredBody = '{"echo":' + escapedString(mockEnv.AGS_BOOTSTRAP_JEV_KEY) + "," + deliveredBody.slice(1);
      }
      if (spec.id === "endpoint-echo") {
        deliveredBody = '{"echo":' + JSON.stringify(mockEnv.AGS_BOOTSTRAP_ENDPOINT) + "," + deliveredBody.slice(1);
      }
      if (spec.id === "overwritten-secret") {
        // JSON.parse keeps the last model; raw retention must still reject the earlier secret.
        deliveredBody = '{"model":' + escapedString(mockEnv.AGS_BOOTSTRAP_JEV_KEY) + "," + deliveredBody.slice(1);
      }
      if (spec.id === "safe-chunk-read-error" || spec.id === "truncated-read-error") {
        let sent = false;
        const chunk = spec.id === "truncated-read-error" ? deliveredBody.slice(0, -8) : deliveredBody;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) {sent = true; controller.enqueue(new TextEncoder().encode(chunk));}
            else controller.error(new Error("synthetic-read-error"));
          },
        }));
      }
      if (spec.id === "timeout-safe-chunk") {
        let sent = false;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) {sent = true; controller.enqueue(new TextEncoder().encode(deliveredBody)); return;}
            pending.reached = true;
            void nextTurn().then(() => {
              controlledAbortTriggered = true;
              abortCallbacks[0]?.(); // Actual AbortController.abort(), never a fabricated signal event.
            });
            return new Promise<void>(resolve => {pending.release = resolve;});
          },
          cancel() {cancellations++;},
        }));
      }
      if (spec.id === "byte-cap") {
        let sent = false;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) {sent = true; controller.enqueue(new TextEncoder().encode("{"));}
            else controller.enqueue(new TextEncoder().encode(deliveredBody));
          },
          cancel() {cancellations++;},
        }));
      }
      if (spec.id === "invalid-utf8") return new Response(new Uint8Array([0xc3, 0x28]));
      if (spec.id === "invalid-json") return new Response('{"model":');
      return new Response(deliveredBody, {status: spec.id === "http500" ? 500 : 200});
    };
    const result = await (async () => {
      try {return await api.run(config, {env: {...mockEnv}, fetcher, executionKind: "offline-mock"});}
      finally {
        if (spec.id === "timeout-safe-chunk") {
          globalThis.setTimeout = nativeSetTimeout;
          for (const timer of fallbackTimers) clearTimeout(timer);
        }
      }
    })() as unknown as {
      status: string; transportAttempts: number; stopReason: string | null; qualificationStatus: string; productionProfileWritten: boolean};
    assert.equal(result.status, "RAW_EVALUATION_RECORDED", spec.id);
    if (spec.error !== undefined) assert.equal(result.stopReason, spec.error, spec.id);
    assert.equal(calls, 1, spec.id); // Includes failures: no resend or alternate attempt.
    assert.equal(result.transportAttempts, 1, spec.id);
    assert.equal(result.qualificationStatus, "NOT_RUN", spec.id);
    assert.equal(result.productionProfileWritten, false, spec.id);
    const stored = await readFile(path.join(output, prepared.requests[0]!.caseId + ".raw.json"), "utf8");
    const raw = JSON.parse(stored) as Raw;
    if (spec.error !== undefined) assert.equal(raw.errorCode, spec.error, spec.id);
    assert.equal(raw.transportAttempts, 1, spec.id);
    assert.ok(raw.providerObservation, spec.id);
    const observation = raw.providerObservation;
    assert.equal(observation.rawBody, spec.keepRaw ? deliveredBody : null, spec.id);
    assert.equal(observation.omissionReason, spec.omission, spec.id);
    assert.equal(observation.partial, spec.partial, spec.id);
    if (observation.byteCount !== undefined) {
      assert.ok(Number.isSafeInteger(observation.byteCount), spec.id);
      assert.ok(observation.byteCount >= 0 && observation.byteCount <= config.limits!.responseBytes, spec.id);
    }
    assert.equal(observation.usage.inputTokens, spec.knownUsage ? 37 : null, spec.id);
    assert.equal(observation.usage.outputTokens, spec.knownUsage ? 7 : null, spec.id);
    assert.equal(observation.usage.actualCostUsd, null, spec.id);
    // Retention does not prescribe parser acceptance of unrelated root fields.
    // If decoded, protocol usage is known; otherwise only the safe observation may supply it.
    const rawUsageKnown = spec.knownUsage || (spec.error === undefined && raw.response !== null);
    assert.equal(raw.usage.inputTokens, rawUsageKnown ? 37 : null, spec.id);
    assert.equal(raw.usage.outputTokens, rawUsageKnown ? 7 : null, spec.id);
    assert.equal(raw.usage.actualCostUsd, null, spec.id);
    if (spec.error) assert.equal(raw.response, null, spec.id);
    assert.ok(!stored.includes(mockEnv.AGS_BOOTSTRAP_JEV_KEY), spec.id);
    assert.ok(!stored.includes(mockEnv.AGS_BOOTSTRAP_ENDPOINT), spec.id);
    assert.ok(!stored.includes(escapedString(mockEnv.AGS_BOOTSTRAP_JEV_KEY).slice(1, -1)), spec.id);
    const ledger = JSON.parse(await readFile(path.join(output, "ledger.json"), "utf8")) as {entries: Entry[]};
    assert.equal(ledger.entries.length, 1, spec.id);
    assert.equal(ledger.entries[0]!.state, "unknown", spec.id);
    assert.equal(ledger.entries[0]!.actualCostUsd, null, spec.id);
    assert.equal(ledger.entries[0]!.reservedUsd, 0.001, spec.id);
    assert.equal(raw.costAccounting.unknownReservedUsd, 0.001, spec.id);
    if (spec.id === "byte-cap") assert.equal(cancellations, 1, spec.id);
    if (spec.id === "timeout-safe-chunk") {
      assert.equal(abortCallbacks.length, 1, spec.id);
      assert.equal(abortInvocations, 1, spec.id);
      assert.equal(controlledAbortTriggered, true, spec.id);
      assert.equal(actualSignal?.aborted, true, spec.id);
      assert.equal(globalThis.setTimeout, nativeSetTimeout, spec.id);
      assert.equal(pending.reached, true, spec.id);
      assert.equal(observation.byteCount, Buffer.byteLength(deliveredBody, "utf8"), spec.id);
      assert.equal(cancellations, 1, spec.id);
      const beforeLateLedger = await readFile(path.join(output, "ledger.json"));
      assert.ok(pending.release, spec.id);
      pending.release();
      await nextTurn();
      await nextTurn();
      assert.deepEqual(await readFile(path.join(output, "ledger.json")), beforeLateLedger, spec.id);
      assert.equal(await readFile(path.join(output, prepared.requests[0]!.caseId + ".raw.json"), "utf8"), stored, spec.id);
      assert.equal(calls, 1, spec.id);
      assert.equal(cancellations, 1, spec.id);
    }
    checked.push(spec.id);
  }
  return checked; // Fixed mock answers are protocol fixtures, never model quality gold.
}
