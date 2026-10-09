# Provider boundary cross-writer interface proposal (not applied)

Base: c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6 / 28f2f2ed8a864405320f6d20e7bc5004e8466ad3.

Current `SkillClassificationProviderPort.classify(request, profile, signal)` exposes request/profile values and cancellation only. `SkillClassificationService` has `getCurrentSnapshot`, but the provider cannot call it after an asynchronous credential lookup. A task/config/profile/inventory/runtime source change without signal abort may therefore precede a fetch even though the service rejects the final stale result later.

Minimal proposed port extension, owned by types/service writers:

```ts
classify(
  request: SkillClassificationRequestV1,
  profile: ProviderProfile,
  signal: AbortSignal,
  beforeDispatch?: () => void,
): Promise<ProviderEvaluation>;
```

The service passes a synchronous closure checking signal + current snapshot against the frozen snapshot, throwing `ClassificationProviderError("STALE_CLASSIFICATION", "not-started")` on mismatch. The remote provider calls it immediately before fetch after credential awaits and synchronous wire encoding. Native callback adapters call it immediately before invocation. The callback must not await or perform I/O. Route/profile local mutation/expiry checks and `signal.aborted` are implemented within this provider-only candidate; snapshot closure wiring is NOT implemented. Other providers may ignore an optional parameter, so full port adoption needs writer tests and must not be claimed for unadapted implementations.

Retry-After observation forwarding also needs a separate decision by types/service owners. This candidate adds a sanitized `ClassificationProviderError.rateLimitObservation` containing only HTTP429/529 status and structured finite safe delay seconds or canonical ISO date, never raw headers/body/credentials. Existing service catch reconstructs the error and drops unknown metadata. Suggested minimal optional fields:

```ts
interface ClassificationAttempt {
  // existing fields...
  rateLimitObservation?: {
    httpStatus: 429 | 529;
    retryAfter: {kind: "delay-seconds"; seconds: number}
      | {kind: "http-date"; at: string} | null;
  } | null;
}
```

Service should carry sanitized observation into its attempt separately, without changing error code, retryability, dispatch/cost uncertainty, or scheduling a retry. Shared type aliases and any serialized contract update belong to the respective writers. This proposal is documentary only; `types.ts`, `service.ts`, `gateway.ts`, `inventory.ts`, R14 and R13 harness files are untouched.
