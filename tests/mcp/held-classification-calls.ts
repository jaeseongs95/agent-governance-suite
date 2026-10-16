// The observed full-suite inventory reads took 1.54–1.72s. Allow twice that
// measured maximum, rounded up, without turning the 30s case limit into an SLA.
export const concurrentWaitMs = 4_000;
export const heldProviderTimeoutMs = 2 * concurrentWaitMs;
export const concurrentRequestTimeoutMs = 3 * concurrentWaitMs;

// ponytail: two calls only; consume each immediately and drain before cleanup.
export async function heldClassificationCalls<T>(
  startFirst: () => Promise<T>,
  entered: Promise<void>,
  startSecond: () => Promise<T>,
  release: () => void,
  assertObserved: () => Promise<unknown>,
): Promise<[T, T]> {
  const first = Promise.allSettled([startFirst()]);
  let second: Promise<PromiseSettledResult<T>[]> | undefined;
  try {
    // The test-only transport deadline also bounds a missing provider entry.
    await Promise.race([entered, first.then(outcomes => {
      const outcome = outcomes[0]!;
      if (outcome.status === "rejected") throw outcome.reason;
      throw new Error("First call settled before the held provider was entered");
    })]);
    second = Promise.allSettled([startSecond()]);
    await assertObserved();
  } finally {
    release();
    await Promise.all([first, second]);
  }
  const a = (await first)[0]!, b = (await second!)[0]!;
  if (a.status === "rejected") throw a.reason;
  if (b.status === "rejected") throw b.reason;
  return [a.value, b.value];
}
