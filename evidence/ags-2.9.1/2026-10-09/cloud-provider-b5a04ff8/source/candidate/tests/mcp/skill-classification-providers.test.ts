import {afterEach, describe, expect, it, vi} from "vitest";
import {ApprovedRouteClassificationProvider, buildVendorMessages, ClassificationProviderError, jevNoulWireAdapter, unknownUsage, type ApprovedClassificationRoute} from "../../mcp-server/src/skill-classification/providers.js";
import {createClassificationRequest} from "../../mcp-server/src/skill-classification/request.js";
import {digestProviderProfileConfiguration} from "../../mcp-server/src/skill-classification/profiles.js";
import type {ProviderProfile} from "../../mcp-server/src/skill-classification/types.js";

function fixture() {
  const request = createClassificationRequest({requestId: "r", operationId: "o", originalPrompt: "읽기 전용, 수정 금지. 고정 diff 검토.", inventory: {skills: [{skillId: "review", version: "1", description: "고정 변경분 검토", enabled: true, installed: true, hostSupported: true, capabilities: ["review"], actions: ["review"], targets: ["diff"], constraints: ["read-only"], applicability: ["fixed diff"], exclusions: ["implementation"], dependencies: [], phases: [], sourceRefs: [{path: "LOCAL_PATH_NOT_FOR_WIRE", digest: `sha256:${"b".repeat(64)}`}]}], issues: [], inventoryDigest: `sha256:${"a".repeat(64)}`, taxonomyRevision: "t1"}, classificationCriteriaRef: "criteria"});
  const profile: ProviderProfile = {profileId: "jev", providerKind: "jev", vendorId: "typesafe", modelId: "fixed-jev", modelRevision: "fixed-jev", reasoningEffort: null, supportedOptions: {reasoningEfforts: [null], structuredOutput: true}, approvedRouteRef: "approved-existing", qualificationRevision: "q1", qualification: {status: "PASS", inventoryDigest: request.inventoryDigest, taxonomyRevision: "t1", modelRevision: "fixed-jev", promptRevision: "p1", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""}, adapterRevision: "a1", promptRevision: "p1", maximumInputBytes: 100000, maximumOutputTokens: 1000, maximumCostUsd: 0.4, judgmentPolicy: {neededAt: 0.8, notNeededAt: 0.2}};
  profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
  const key = vi.fn(async () => "SECRET_SENTINEL");
  const route: ApprovedClassificationRoute = {routeRef: "approved-existing", approvalRef: "fixture-approval", approved: true, kind: "remote", providerKind: "jev", vendorId: "typesafe", adapterRevision: "a1", modelIds: ["fixed-jev"], reasoningEfforts: [null], structuredOutput: true, endpoint: "https://approved.example.invalid/fixture", getCredential: key, adapter: jevNoulWireAdapter};
  const body = {model: "fixed-jev", answers: {review: {type: "noul", noul: 0.82}}, usage: {input_tokens: 354, output_tokens: 58}};
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), {status: 200}));
  const provider = new ApprovedRouteClassificationProvider([route], fetcher);
  return {request, profile, key, route, body, fetcher, provider};
}
afterEach(() => vi.useRealTimers());
describe("approved classification wire adapters", () => {
  it("SS20/21 transmits one bound TypeSafe state/questions request using the exact profile model", async () => {
    const f = fixture(); expect((await f.provider.availability(f.profile)).available).toBe(true);
    const result = await f.provider.classify(f.request, f.profile, new AbortController().signal);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const [endpoint, init] = f.fetcher.mock.calls[0]!;
    expect(String(endpoint)).toBe(f.route.kind === "remote" ? f.route.endpoint : "");
    const wire = JSON.parse(String(init?.body));
    expect(wire).toMatchObject({model: "fixed-jev", state: {originalPrompt: f.request.originalPrompt}, questions: {review: {type: "noul"}}});
    expect(wire.questions.review.instructions.skill.exclusions).toEqual(["implementation"]);
    expect(JSON.stringify(wire)).not.toContain("LOCAL_PATH_NOT_FOR_WIRE");
    expect(init?.redirect).toBe("error"); expect(init?.headers).toMatchObject({authorization: "Bearer SECRET_SENTINEL"});
    expect(result.response.judgments).toEqual([{skillId: "review", judgment: "needed", reasonRefs: ["profile:jev:p1"], uncertaintyReason: null}]);
    expect(result.usage).toEqual({inputTokens: 354, outputTokens: 58, cachedInputTokens: null, actualCostUsd: null});
    expect(result.diagnostics).toEqual({scoreKind: "noul_probability", scores: [{skillId: "review", value: 0.82}]});
    expect(JSON.stringify(result)).not.toContain("SECRET_SENTINEL"); expect(JSON.stringify(result)).not.toContain("confidence");
  });
  it.each([401, 403, 429, 529, 500])("SS30/32 HTTP %i is sanitized and is never retried", async status => {
    const f = fixture(); f.fetcher.mockResolvedValue(new Response("SECRET_SENTINEL private exception", {status}));
    const error = await f.provider.classify(f.request, f.profile, new AbortController().signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClassificationProviderError); expect(JSON.stringify(error)).not.toContain("SECRET_SENTINEL");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({dispatchState: "started", code: status === 401 || status === 403 ? "AUTH_UNAVAILABLE" : status === 429 || status === 529 ? "RATE_LIMITED" : "API_UNAVAILABLE"});
  });
  it.each(["unknown-id", "missing-id", "wrong-type", "nan", "out-of-range", "wrong-model", "malformed"])("SS27/28 rejects %s responses rather than producing no-skill", async variant => {
    const f = fixture(); let body: unknown = f.body;
    if (variant === "unknown-id") body = {...f.body, answers: {other: {type: "noul", noul: 0.9}}};
    if (variant === "missing-id") body = {...f.body, answers: {}};
    if (variant === "wrong-type") body = {...f.body, answers: {review: {type: "score", noul: 0.9}}};
    if (variant === "nan") body = {...f.body, answers: {review: {type: "noul", noul: NaN}}};
    if (variant === "out-of-range") body = {...f.body, answers: {review: {type: "noul", noul: 2}}};
    if (variant === "wrong-model") body = {...f.body, model: "premium"};
    f.fetcher.mockResolvedValue(new Response(variant === "malformed" ? '{"answers":' : JSON.stringify(body), {status: 200}));
    await expect(f.provider.classify(f.request, f.profile, new AbortController().signal)).rejects.toMatchObject({code: "INVALID_PROVIDER_RESPONSE", invalid: true});
  });
  it("SS29 intermediate Noul is UNCERTAIN; low calibrated not-needed remains explicit", () => {
    const f = fixture(); f.body.answers.review.noul = 0.5;
    const result = jevNoulWireAdapter.decode(f.body, f.request, f.profile);
    expect(result.response.status).toBe("UNCERTAIN"); expect(result.response.judgments[0]?.judgment).toBe("uncertain");
    f.body.answers.review.noul = 0.1; expect(jevNoulWireAdapter.decode(f.body, f.request, f.profile).response.judgments[0]?.judgment).toBe("not-needed");
  });
  it("SS28 input over limit never sends and never silently drops its trailing prohibition", async () => {
    const f = fixture(); f.profile.maximumInputBytes = 1;
    f.profile.qualificationRevision = "synthetic-input-ceiling";
    f.profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(f.profile);
    await expect(f.provider.classify(f.request, f.profile, new AbortController().signal)).rejects.toMatchObject({code: "INPUT_TOO_LONG", dispatchState: "not-started"});
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("SS28 counts actual UTF-8 stream bytes before parsing despite a false Content-Length", async () => {
    const f = fixture(); const bytes = new TextEncoder().encode(JSON.stringify({...f.body, note: "합성 SECRET_SENTINEL"}));
    const cancel = vi.fn(); let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({pull(controller) {
      pulls++;
      if (pulls === 1) controller.enqueue(bytes.subarray(0, 8));
      else if (pulls === 2) controller.enqueue(bytes.subarray(8));
      else controller.close();
    }, cancel}, {highWaterMark: 0});
    const response = new Response(stream, {headers: {"content-length": "1"}}); const json = vi.spyOn(response, "json");
    f.fetcher.mockResolvedValue(response);
    const decode = vi.fn(jevNoulWireAdapter.decode);
    if (f.route.kind === "remote") f.route.adapter = {...jevNoulWireAdapter, decode};
    const provider = new ApprovedRouteClassificationProvider([f.route], f.fetcher, {maximumResponseBytes: bytes.byteLength - 1});
    const error = await provider.classify(f.request, f.profile, new AbortController().signal).catch((value: unknown) => value);
    expect(error).toMatchObject({code: "PROVIDER_RESPONSE_TOO_LARGE", dispatchState: "unknown", invalid: true});
    expect(JSON.stringify(error)).not.toContain("SECRET_SENTINEL"); expect(cancel).toHaveBeenCalledTimes(1);
    expect(decode).not.toHaveBeenCalled(); expect(json).not.toHaveBeenCalled(); expect(stream.locked).toBe(false);
  });
  it("SS28 accepts an exact byte ceiling without trusting an oversized Content-Length", async () => {
    const f = fixture(); const bytes = new TextEncoder().encode(JSON.stringify(f.body));
    f.fetcher.mockResolvedValue(new Response(bytes, {headers: {"content-length": "999999999"}}));
    const provider = new ApprovedRouteClassificationProvider([f.route], f.fetcher, {maximumResponseBytes: bytes.byteLength});
    expect((await provider.classify(f.request, f.profile, new AbortController().signal)).response.status).toBe("SUCCESS");
  });
  it("SS28 multiple individually small chunks cannot evade the cumulative byte ceiling", async () => {
    const f = fixture(); const cancel = vi.fn(); let count = 0;
    const stream = new ReadableStream<Uint8Array>({pull(controller) {
      count++; if (count <= 3) controller.enqueue(new Uint8Array(4).fill(32)); else controller.close();
    }, cancel}, {highWaterMark: 0});
    f.fetcher.mockResolvedValue(new Response(stream));
    const provider = new ApprovedRouteClassificationProvider([f.route], f.fetcher, {maximumResponseBytes: 8});
    await expect(provider.classify(f.request, f.profile, new AbortController().signal)).rejects.toMatchObject({code: "PROVIDER_RESPONSE_TOO_LARGE", dispatchState: "unknown"});
    expect(cancel).toHaveBeenCalledTimes(1); expect(stream.locked).toBe(false);
  });
  it("SS28 malformed bounded JSON and invalid UTF-8 never become classification success", async () => {
    const f = fixture(); const provider = new ApprovedRouteClassificationProvider([f.route], f.fetcher, {maximumResponseBytes: 64});
    f.fetcher.mockResolvedValue(new Response('{"answers":'));
    await expect(provider.classify(f.request, f.profile, new AbortController().signal)).rejects.toMatchObject({code: "INVALID_PROVIDER_RESPONSE", invalid: true});
    f.fetcher.mockResolvedValue(new Response(new Uint8Array([0xff])));
    await expect(provider.classify(f.request, f.profile, new AbortController().signal)).rejects.toMatchObject({code: "INVALID_PROVIDER_RESPONSE", invalid: true});
  });
  it("SS28 partial stream failure is sanitized and releases its reader", async () => {
    const f = fixture(); let count = 0;
    const stream = new ReadableStream<Uint8Array>({pull(controller) { if (++count === 1) controller.enqueue(new TextEncoder().encode("{")); else controller.error(new Error("SECRET_SENTINEL")); }});
    f.fetcher.mockResolvedValue(new Response(stream));
    const error = await f.provider.classify(f.request, f.profile, new AbortController().signal).catch((value: unknown) => value);
    expect(error).toMatchObject({code: "TRANSPORT_UNAVAILABLE", dispatchState: "unknown"}); expect(JSON.stringify(error)).not.toContain("SECRET_SENTINEL"); expect(stream.locked).toBe(false);
  });
  it("SS39 rejects missing approval, unsupported models/options and absent credentials before transport", async () => {
    const f = fixture(); f.route.approved = false; expect((await f.provider.availability(f.profile)).available).toBe(false);
    f.route.approved = true; f.profile.modelId = "premium"; expect((await f.provider.availability(f.profile)).available).toBe(false);
    f.profile.modelId = "fixed-jev"; f.route.reasoningEfforts = []; expect((await f.provider.availability(f.profile)).available).toBe(false);
    f.route.reasoningEfforts = [null]; f.key.mockResolvedValue(null as unknown as string); expect((await f.provider.availability(f.profile)).available).toBe(false);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("SS39 supplied vendor wire mapping sees fixed model/effort and preserves meaningful metadata", async () => {
    const f = fixture(); f.profile.providerKind = "vendor"; f.profile.vendorId = "current-vendor"; f.profile.modelId = "model-a"; f.profile.modelRevision = "model-a"; f.profile.reasoningEffort = "low";
    f.profile.supportedOptions.reasoningEfforts = ["low"]; f.profile.judgmentPolicy = null;
    f.profile.qualification.modelRevision = "model-a"; f.profile.qualificationRevision = "synthetic-vendor-wire";
    f.profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(f.profile);
    const encode = vi.fn((request, profile) => ({model: profile.modelId, reasoning: profile.reasoningEffort, max_output_tokens: profile.maximumOutputTokens, messages: buildVendorMessages(request)}));
    const decode = vi.fn(() => ({response: {schemaVersion: "1.0.0" as const, requestId: f.request.requestId, operationId: f.request.operationId, requestDigest: f.request.requestDigest, inventoryDigest: f.request.inventoryDigest, status: "SUCCESS" as const, judgments: [{skillId: "review", judgment: "needed" as const, reasonRefs: ["fixture"], uncertaintyReason: null}], unresolvedItems: [], error: null}, dispatchState: "started" as const, usage: unknownUsage(), diagnostics: null}));
    const route: ApprovedClassificationRoute = {...f.route, providerKind: "vendor", vendorId: "current-vendor", modelIds: ["model-a"], reasoningEfforts: ["low"], adapter: {encode, decode}};
    const provider = new ApprovedRouteClassificationProvider([route], f.fetcher);
    await provider.classify(f.request, f.profile, new AbortController().signal);
    const wire = JSON.parse(String(f.fetcher.mock.calls[0]?.[1]?.body)); expect(wire).toMatchObject({model: "model-a", reasoning: "low", max_output_tokens: 1000});
    const user = JSON.parse(wire.messages[1].content); expect(user.originalPrompt).toBe(f.request.originalPrompt); expect(user.skills[0].exclusions).toEqual(["implementation"]);
    expect(wire.messages[1].content).not.toContain("LOCAL_PATH_NOT_FOR_WIRE"); expect(decode).toHaveBeenCalledTimes(1);
  });
  it("SS39 native success requires an actual invoked structured capability with its approved evidence", async () => {
    const f = fixture(); const invokeStructured = vi.fn(async () => jevNoulWireAdapter.decode(f.body, f.request, f.profile));
    const provider = new ApprovedRouteClassificationProvider([{routeRef: f.route.routeRef, approvalRef: f.route.approvalRef, approved: true, providerKind: "jev", vendorId: "typesafe", adapterRevision: "a1", modelIds: ["fixed-jev"], reasoningEfforts: [null], structuredOutput: true, kind: "native", invokeStructured}], f.fetcher);
    expect((await provider.availability(f.profile)).routeKind).toBe("native");
    expect((await provider.classify(f.request, f.profile, new AbortController().signal)).response.status).toBe("SUCCESS");
    expect(invokeStructured).toHaveBeenCalledTimes(1); expect(f.key).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each([429, 529])("SS32 HTTP %i retains delay-seconds without retrying or exposing raw data", async status => {
    const f = fixture();
    f.fetcher.mockResolvedValue(new Response("SECRET_SENTINEL private body", {status, headers: {"retry-after": "15"}}));
    const error = await f.provider.classify(f.request, f.profile, new AbortController().signal).catch((value: unknown) => value);
    expect(error).toMatchObject({code: "RATE_LIMITED", dispatchState: "started", rateLimitObservation: {httpStatus: status, retryAfter: {kind: "delay-seconds", seconds: 15}}});
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error)).not.toContain("SECRET_SENTINEL");
  });
  it("SS32 canonical HTTP-date is observation only, even when already past", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(new Response("", {status: 529, headers: {"retry-after": "Sun, 06 Nov 1994 08:49:37 GMT"}}));
    const error = await f.provider.classify(f.request, f.profile, new AbortController().signal).catch((value: unknown) => value);
    expect(error).toMatchObject({rateLimitObservation: {httpStatus: 529, retryAfter: {kind: "http-date", at: "1994-11-06T08:49:37.000Z"}}});
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["SECRET_SENTINEL", "15 SECRET_SENTINEL", "-1", "1.5", "9007199254740992", "Mon, 06 Nov 1994 08:49:37 GMT", "Sun, 31 Feb 1994 08:49:37 GMT"])("SS32 unsafe Retry-After %s is suppressed", async header => {
    const f = fixture(); f.fetcher.mockResolvedValue(new Response("SECRET_SENTINEL", {status: 429, headers: {"retry-after": header}}));
    const error = await f.provider.classify(f.request, f.profile, new AbortController().signal).catch((value: unknown) => value);
    expect(error).toMatchObject({rateLimitObservation: {httpStatus: 429, retryAfter: null}});
    expect(JSON.stringify(error)).not.toContain("SECRET_SENTINEL"); expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["0", "00015", "9007199254740991"])("SS32 valid delay-seconds %s remains exact safe numeric observation", async header => {
    const f = fixture(); f.fetcher.mockResolvedValue(new Response("", {status: 429, headers: {"retry-after": header}}));
    const error = await f.provider.classify(f.request, f.profile, new AbortController().signal).catch((value: unknown) => value);
    expect(error).toMatchObject({rateLimitObservation: {httpStatus: 429, retryAfter: {kind: "delay-seconds", seconds: Number(header)}}});
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("SS32 absent Retry-After and non-rate-limit responses do not invent observations", async () => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(new Response("", {status: 429})).mockResolvedValueOnce(new Response("", {status: 500, headers: {"retry-after": "15"}}));
    const first = await f.provider.classify(f.request, f.profile, new AbortController().signal).catch((value: unknown) => value);
    const second = await f.provider.classify(f.request, f.profile, new AbortController().signal).catch((value: unknown) => value);
    expect(first).toMatchObject({rateLimitObservation: {httpStatus: 429, retryAfter: null}});
    expect(second).toMatchObject({code: "API_UNAVAILABLE", rateLimitObservation: null});
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(["approval", "approval-ref", "model", "reasoning", "endpoint", "adapter-revision", "adapter-function", "credential-function", "profile", "qualification", "request"])("PRE %s mutation during credential await prevents transport", async change => {
    const f = fixture(); let release!: (key: string) => void;
    f.key.mockImplementation(() => new Promise(resolve => {release = resolve;}));
    const pending = f.provider.classify(f.request, f.profile, new AbortController().signal);
    expect(f.key).toHaveBeenCalledTimes(1);
    if (change === "approval") f.route.approved = false;
    if (change === "approval-ref") f.route.approvalRef = "changed-approval";
    if (change === "model") f.route.modelIds = ["different-model"];
    if (change === "reasoning") f.route.reasoningEfforts = ["unsupported"];
    if (change === "adapter-revision") f.route.adapterRevision = "different-revision";
    if (f.route.kind === "remote") {
      if (change === "endpoint") f.route.endpoint = "https://different.example.invalid/";
      if (change === "adapter-function") f.route.adapter = {...jevNoulWireAdapter, encode: () => ({changed: true})};
      if (change === "credential-function") f.route.getCredential = async () => "different-credential";
    }
    if (change === "profile") f.profile.maximumOutputTokens++;
    if (change === "qualification") f.profile.qualification.status = "NOT_RUN";
    if (change === "request") f.request.originalPrompt = "Different objective";
    release("SECRET_SENTINEL");
    await expect(pending).rejects.toMatchObject({code: "STALE_CLASSIFICATION", dispatchState: "not-started"});
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("PRE route replacement while awaiting credentials is not the original approved route", async () => {
    const f = fixture(), routes = [f.route]; let release!: (key: string) => void;
    f.key.mockImplementation(() => new Promise(resolve => {release = resolve;}));
    const provider = new ApprovedRouteClassificationProvider(routes, f.fetcher);
    const pending = provider.classify(f.request, f.profile, new AbortController().signal);
    routes[0] = {...f.route}; release("SECRET_SENTINEL");
    await expect(pending).rejects.toMatchObject({code: "STALE_CLASSIFICATION", dispatchState: "not-started"});
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("PRE qualification expiring during credential await prevents transport", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-09T00:00:00Z"));
    const f = fixture(); f.profile.qualification.validUntil = "2026-10-09T00:00:01Z";
    let release!: (key: string) => void; f.key.mockImplementation(() => new Promise(resolve => {release = resolve;}));
    const pending = f.provider.classify(f.request, f.profile, new AbortController().signal);
    vi.setSystemTime(new Date("2026-10-09T00:00:01Z")); release("SECRET_SENTINEL");
    await expect(pending).rejects.toMatchObject({code: "STALE_CLASSIFICATION", dispatchState: "not-started"});
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("PRE synchronous encode mutation is fenced immediately before fetch", async () => {
    const f = fixture();
    if (f.route.kind === "remote") f.route.adapter = {...jevNoulWireAdapter, encode(request, profile) {f.route.approvalRef = "changed-during-encode"; return jevNoulWireAdapter.encode(request, profile);}};
    await expect(f.provider.classify(f.request, f.profile, new AbortController().signal)).rejects.toMatchObject({code: "STALE_CLASSIFICATION", dispatchState: "not-started"});
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(["profile", "request"])("PRE encode cannot change its bound %s snapshot", async changed => {
    const f = fixture();
    if (f.route.kind === "remote") f.route.adapter = {...jevNoulWireAdapter, encode(request, profile) {
      const encoded = jevNoulWireAdapter.encode(request, profile);
      if (changed === "profile") profile.modelId = "unapproved-premium";
      else request.originalPrompt = "Changed objective";
      return encoded;
    }};
    await expect(f.provider.classify(f.request, f.profile, new AbortController().signal)).rejects.toMatchObject({code: "STALE_CLASSIFICATION", dispatchState: "not-started"});
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("PRE cancellation during credential await is confirmed not-started at this provider boundary", async () => {
    const f = fixture(), controller = new AbortController(); let release!: (key: string) => void;
    f.key.mockImplementation(() => new Promise(resolve => {release = resolve;}));
    const pending = f.provider.classify(f.request, f.profile, controller.signal); controller.abort(); release("SECRET_SENTINEL");
    await expect(pending).rejects.toMatchObject({code: "CANCELLED", dispatchState: "not-started"});
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    '"review":{"type":"noul","noul":0.1},"review":{"type":"noul","noul":0.9}',
    '"review":{"type":"noul","noul":0.1},"revi\\u0065w":{"type":"noul","noul":0.9}',
    '"review":{"type":"noul","noul":0.9},"review":{"type":"noul","noul":0.9}',
    '"review":{"type":"noul","noul":0.1,"noul":0.9}',
    '"review":{"type":"other","type":"noul","noul":0.9}',
  ])("SS27 ambiguous duplicate wire answer %s is INVALID", async answers => {
    const f = fixture(); f.fetcher.mockResolvedValue(new Response(`{"model":"fixed-jev","answers":{${answers}},"usage":{"input_tokens":1,"output_tokens":1}}`));
    await expect(f.provider.classify(f.request, f.profile, new AbortController().signal)).rejects.toMatchObject({code: "INVALID_PROVIDER_RESPONSE", dispatchState: "started", invalid: true});
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("SS27 duplicate answers containers cannot hide contradictory earlier answers", async () => {
    const f = fixture(); f.fetcher.mockResolvedValue(new Response('{"model":"fixed-jev","answers":{"review":{"type":"noul","noul":0.1}},"answ\\u0065rs":{"review":{"type":"noul","noul":0.9}},"usage":{"input_tokens":1,"output_tokens":1}}'));
    await expect(f.provider.classify(f.request, f.profile, new AbortController().signal)).rejects.toMatchObject({code: "INVALID_PROVIDER_RESPONSE", invalid: true});
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("SS27 unique escaped answer keys and JSON-looking text are accepted unchanged", async () => {
    const f = fixture();
    const body = {...f.body, answers: {review: {type: "noul", noul: 0.9, note: '} [ "review": { "noul": 0.1, "noul": 0.9 }'}}, metadata: {answers: {review: 1}, text: "opaque"}};
    f.fetcher.mockResolvedValue(new Response(JSON.stringify(body).replace('"review":', '"revi\\u0065w":')));
    expect((await f.provider.classify(f.request, f.profile, new AbortController().signal)).response.judgments[0]?.judgment).toBe("needed");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("SS27 unrelated metadata duplicates retain JSON.parse semantics, not a global new JSON policy", async () => {
    const f = fixture(); f.fetcher.mockResolvedValue(new Response('{"model":"fixed-jev","answers":{"review":{"type":"noul","noul":0.9,"metadata":{"noul":0,"noul":1}}},"usage":{"input_tokens":1,"output_tokens":1},"metadata":{"note":"first","note":"last"}}'));
    expect((await f.provider.classify(f.request, f.profile, new AbortController().signal)).response.status).toBe("SUCCESS");
  });
  it("SS27 a decorated JEV adapter retains its raw answer-key check", async () => {
    const f = fixture(); const decode = vi.fn(jevNoulWireAdapter.decode);
    if (f.route.kind === "remote") f.route.adapter = {...jevNoulWireAdapter, decode};
    f.fetcher.mockResolvedValue(new Response('{"model":"fixed-jev","answers":{"review":{"type":"noul","no\\u0075l":0.1,"noul":0.9}},"usage":{"input_tokens":1,"output_tokens":1}}'));
    await expect(f.provider.classify(f.request, f.profile, new AbortController().signal)).rejects.toMatchObject({code: "INVALID_PROVIDER_RESPONSE", invalid: true});
    expect(decode).not.toHaveBeenCalled(); expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
});
