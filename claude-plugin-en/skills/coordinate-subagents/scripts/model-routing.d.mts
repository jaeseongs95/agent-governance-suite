export interface ModelSettingV1 {
  model: string;
  effort: string;
}

export interface ModelSelectionResultV1 {
  requested: { model: string | null; effort: string | null } | null;
  selection: ModelSettingV1 | null;
  delivery: "explicit" | "inherited" | "blocked";
  fallbackReason: string | null;
}

// Inputs remain untrusted until the JavaScript boundary validates them.
export function getPolicyRevision(customPresets?: unknown): string;
export function resolveModelSelection(options: unknown, customPresets?: unknown): ModelSelectionResultV1;
export function recordModelApplication(input: unknown, customPresets?: unknown): Record<string, unknown>;
