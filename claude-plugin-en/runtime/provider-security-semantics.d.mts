export function canonical(value: unknown): string;
export function digestBytes(value: string | Uint8Array): string;
export function digest(value: unknown): string;
export function targetDigest(request: {target: unknown}): string;
export function safeRelative(value: unknown): boolean;
export function validateSemantics(report: unknown): string[];
