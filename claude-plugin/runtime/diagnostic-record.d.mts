export function diagnosticRecord(component: string, event: string, details: Readonly<Record<string, unknown>>): string;
export function isDiagnosticRecord(text: unknown): boolean;
export const consoleStderr: (line: string) => void;
export const syncStderr: (line: string) => void;
export const streamStderr: (text: string) => void;
export function writeDiagnostic(component: string, event: string, details: Readonly<Record<string, unknown>>,
  writer?: (line: string) => void): void;
export function writeStageFailure(component: string, event: string, stage: string, cause: unknown,
  observed?: Readonly<Record<string, unknown>>, writer?: (line: string) => void): void;
export function writeRecordLine(text: string, writer?: (text: string) => void): void;
