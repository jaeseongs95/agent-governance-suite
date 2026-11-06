import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";

export const PROVIDER_RETENTION_PURPOSE = "provider-observation-retention" as const;

// Approved purpose changes, not replacements for the frozen model-quality oracle.
// Removal: 0ad3f846. Pre-dispatch role: 20e17f4e. Span rebinding: c7ebdb97. Wording: 98d4beaf.
export const PROVIDER_RETENTION_SOURCE_CHANGES = Object.freeze([
  {path: "skills/codex-token-usage-analyzer/SKILL.md",
    previousDigest: "sha256:0de104afb13d2095c585ec64ca8a326dc8392f03749c70f0a21affab5e060e18", digest: null, bytes: 0},
  {path: "skills/codex-token-usage-analyzer/classification.json",
    previousDigest: "sha256:b9c2eca1a447e64000e57a8c25cd1faa279ad9487c6250b8fb44a15edba39082", digest: null, bytes: 0},
  {path: "skills/coordinate-subagents/SKILL.md",
    previousDigest: "sha256:9dfea8d94be467700ea4e8dac86a21040b57c1161ff46ddc0cf63cef97e305e7",
    digest: "sha256:f5acb926234feda269ec7f0c5faa444fe31cc5f257ba854c505cd37fa4efe881", bytes: 2674},
  {path: "skills/coordinate-subagents/classification.json",
    previousDigest: "sha256:bd2fd05d3e93cd4f4b08af021a0fa77ef3787b57550e17f75fbbe3ecdd629957",
    digest: "sha256:c899d68736407ed7f351345eb620bc0167e15ae93a1c3aa0cf3b010ddd99ae5f", bytes: 4370},
  {path: "skills/coordinate-subagents/references/entry-details.md",
    previousDigest: "sha256:266ceb4fb5d7d3c553ef85485c93ac87c4df1bf0df5e2219fd99cc9a146bf882",
    digest: "sha256:0bca6a11311aedec9bb7c9d4583092ff246452a664686a51041d0c90c6a5b404", bytes: 11051},
  {path: "skills/model-effort-advisor/SKILL.md",
    previousDigest: "sha256:f1142996644991ca8d444a4e4004aa8650f4c00a8d9e9e0eecd5d7672b773595",
    digest: "sha256:3e47fe6b94f671e9b7e91dc57c074078e582556e056b2d66889ec61ea850453d", bytes: 2811},
  {path: "skills/model-effort-advisor/classification.json",
    previousDigest: "sha256:2794ab01288c3d531c49b31704ba565bb554b64fb59369946c39237237038faf",
    digest: "sha256:fec98b3623b3f8984dcf780beb2f535eb9c22eb25953c44d38efbda8af6f4590", bytes: 1516},
]);

/** Retention fixtures use current wire inputs, but never promote old skill-selection gold to the changed purpose. */
type SourceBindings = {
  manifest: {bindings: {path: string; previousDigest: string; digest: string | null; bytes: number}[]};
  files: string[]; digest: string; resolveDigest(path: string, digest: string): string | null;
};
export function bindProviderRetentionSources(current: SourceBindings,
  sourceSkills: {path: string; digest: string}[]) {
  const previous = new Map(sourceSkills.map(source => [source.path, current.resolveDigest(source.path, source.digest)]));
  for (const source of current.manifest.bindings) previous.set(source.path, source.digest);
  for (const source of PROVIDER_RETENTION_SOURCE_CHANGES) {
    if (previous.get(source.path) !== source.previousDigest) throw new Error(`RETENTION_SOURCE_PREDECESSOR_MISMATCH:${source.path}`);
  }
  const changes = new Map(PROVIDER_RETENTION_SOURCE_CHANGES.map(source => [source.path, source]));
  const bindings = new Map(current.manifest.bindings.map(source => [source.path, source]));
  for (const source of PROVIDER_RETENTION_SOURCE_CHANGES) bindings.set(source.path, source);
  return {
    ...current,
    manifest: {...current.manifest, revision: "provider-retention-purpose-change-2026-11-07",
      role: "retention-only-not-model-quality", bindings: [...bindings.values()]},
    files: [...current.files, fileURLToPath(import.meta.url)],
    digest: "sha256:" + createHash("sha256").update(JSON.stringify({predecessor: current.digest,
      purpose: PROVIDER_RETENTION_PURPOSE, changes: PROVIDER_RETENTION_SOURCE_CHANGES})).digest("hex"),
    resolveDigest(sourcePath: string, digest: string): string | null {
      const resolved = current.resolveDigest(sourcePath, digest), change = changes.get(sourcePath);
      if (!change) return resolved;
      if (resolved !== change.previousDigest) throw new Error(`RETENTION_SOURCE_PREDECESSOR_MISMATCH:${sourcePath}`);
      return change.digest;
    },
  };
}
