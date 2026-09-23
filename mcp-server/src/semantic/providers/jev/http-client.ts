import type { BoundedProviderControl } from "../../provider-runner.js";
import { performance } from "node:perf_hooks";
import { checkJevPayloadBytes } from "./request-limits.js";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export type JevHttpResult =
  | { status: "response"; body: unknown; providerAccepted: "confirmed" }
  | { status: "rate-limited" | "unsupported-bytes"; providerAccepted: "no" }
  | { status: "timeout" | "uncertain" | "redirect-rejected"; providerAccepted: "unknown" };

/** Internal transport only; the owning server supplies preflight control and a credential reader. */
export class JevHttpClient {
  constructor(private readonly options: {
    credential: () => string;
    maxResponseBytes: number;
    timeoutMs: number;
    fetcher?: typeof fetch;
  }) {
    for (const value of [options.maxResponseBytes, options.timeoutMs]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
        throw new TypeError("Jev transport limits must be positive safe integers within the timer range.");
      }
    }
  }

  async post(requestText: string, control: BoundedProviderControl): Promise<JevHttpResult> {
    if (control.endpoint !== JEV_ENDPOINT || control.redirect !== "error") {
      throw new TypeError("Jev transport requires the approved exact endpoint and redirect policy.");
    }
    if (checkJevPayloadBytes(requestText)) return { status: "unsupported-bytes", providerAccepted: "no" };
    if (control.signal.aborted) return { status: "uncertain", providerAccepted: "unknown" };
    let token: string;
    try { token = this.options.credential(); }
    catch { throw new TypeError("Jev credential is unavailable."); }
    if (typeof token !== "string" || !token || /\s/u.test(token)) {
      throw new TypeError("Jev credential is unavailable.");
    }

    const aborter = new AbortController();
    const cancel = () => aborter.abort();
    control.signal.addEventListener("abort", cancel, { once: true });
    let expired = false;
    const deadlineAt = performance.now() + this.options.timeoutMs;
    const expire = () => { expired = true; aborter.abort(); };
    const pastDeadline = () => {
      if (!expired && performance.now() >= deadlineAt) expire();
      return expired;
    };
    const timer = setTimeout(expire, this.options.timeoutMs);
    try {
      if (control.signal.aborted) return { status: "uncertain", providerAccepted: "unknown" };
      const response = await (this.options.fetcher ?? fetch)(JEV_ENDPOINT, {
        method: "POST", redirect: "error", signal: aborter.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: requestText,
      });
      if (pastDeadline() || control.signal.aborted) {
        await response.body?.cancel();
        return { status: pastDeadline() ? "timeout" : "uncertain", providerAccepted: "unknown" };
      }
      const redirected = response.redirected || (response.url && response.url !== JEV_ENDPOINT)
        || (response.status >= 300 && response.status < 400);
      if (redirected || response.status !== 200) {
        await response.body?.cancel();
        if (pastDeadline() || control.signal.aborted) {
          return { status: pastDeadline() ? "timeout" : "uncertain", providerAccepted: "unknown" };
        }
        if (redirected) return { status: "redirect-rejected", providerAccepted: "unknown" };
        if (response.status === 429) return { status: "rate-limited", providerAccepted: "no" };
        return { status: "uncertain", providerAccepted: "unknown" };
      }
      if (!response.body) return { status: "uncertain", providerAccepted: "unknown" };

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0, complete = false;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) { complete = true; break; }
          bytes += part.value.byteLength;
          control.onOutput(part.value);
          if (bytes > this.options.maxResponseBytes || control.signal.aborted || pastDeadline()) {
            return { status: pastDeadline() ? "timeout" : "uncertain", providerAccepted: "unknown" };
          }
          chunks.push(part.value);
        }
      } finally {
        if (!complete) await reader.cancel();
      }
      if (control.signal.aborted || pastDeadline()) {
        return { status: pastDeadline() ? "timeout" : "uncertain", providerAccepted: "unknown" };
      }
      try {
        const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        if (pastDeadline() || control.signal.aborted) {
          return { status: pastDeadline() ? "timeout" : "uncertain", providerAccepted: "unknown" };
        }
        return { status: "response", body, providerAccepted: "confirmed" };
      } catch {
        return { status: pastDeadline() ? "timeout" : "uncertain", providerAccepted: "unknown" };
      }
    } catch {
      return { status: pastDeadline() ? "timeout" : "uncertain", providerAccepted: "unknown" };
    } finally {
      clearTimeout(timer);
      control.signal.removeEventListener("abort", cancel);
    }
  }
}
