export function tagProducerFailure<T extends Error>(error: T, reason: string): T;
export function retainFailureCause<T extends Error>(error: T, cause: unknown): T;
export function retainFailureSecondary<T>(error: T, secondary: unknown): T;
export function producerFailure(reason: string, message: string): Error & { readonly code: string };
export function producerFailureReason(error: unknown): string | null;
export function failureContext(error: unknown): Record<string, unknown>;
