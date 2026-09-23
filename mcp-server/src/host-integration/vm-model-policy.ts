import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, type Stats } from "node:fs";
import path from "node:path";

import type { ModelClassV1 } from "../../../contracts/types.js";
import { canonicalJson } from "../convergence-logic.js";

type JsonObject = Record<string, unknown>;
type Pin = { keyId: string; installationId: string; hostId: "flowmarshal-engine";
  publicKeySpki: string; hostBuildDigest: string; modelPolicyVersion: string; status: "active" | "revoked" };
type Model = { hostId: "flowmarshal-engine"; hostBuildDigest: string; observedModelId: string;
  modelClass: ModelClassV1; status: "verified" | "unverified" | "retired" };
type HostBuild = { hostId: "flowmarshal-engine"; hostBuildDigest: string; status: "verified" | "unverified" };
type Policy = { version: 1; modelPolicyVersion: string; pins: Pin[]; hostBuilds: HostBuild[]; models: Model[] };
type PinWithKey = Pin & { key: KeyObject };

export type VmVerifiedProfile = { modelClass: ModelClassV1; actorId: string; observedModelId: string;
  installationId: string; hostBuildDigest: string; modelPolicyVersion: string };

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MODEL_CLASSES: readonly string[] = ["lightweight", "general", "deep", "frontier"];
const SYSTEM_SIDS = new Set(["S-1-5-18", "S-1-5-32-544"]);
const WINDOWS_READ_RIGHTS = 0x1200a9;
const WINDOWS_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const WINDOWS_POLICY_PATH = "C:\\ProgramData\\agent-governance-suite\\vm-operator-policy.json";
const POSIX_POLICY_PATH = "/etc/agent-governance-suite/vm-operator-policy.json";

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}
function exact(value: JsonObject | null, keys: string[]): boolean {
  return !!value && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function fail(message: string): never { throw new Error(`VM operator policy unavailable: ${message}`); }

function parsePolicy(value: unknown): Policy {
  const raw = object(value);
  if (!exact(raw, ["version", "modelPolicyVersion", "pins", "hostBuilds", "models"])
      || raw!.version !== 1 || !nonempty(raw!.modelPolicyVersion)
      || !Array.isArray(raw!.pins) || !Array.isArray(raw!.hostBuilds) || !Array.isArray(raw!.models)) {
    fail("configuration is malformed");
  }
  const keys = new Set<string>(), installations = new Map<string, string>(), builds = new Set<string>(), models = new Set<string>();
  for (const entry of raw!.pins as unknown[]) {
    const pin = object(entry);
    if (!exact(pin, ["keyId", "installationId", "hostId", "publicKeySpki", "hostBuildDigest", "modelPolicyVersion", "status"])
        || !nonempty(pin!.keyId) || !nonempty(pin!.installationId) || pin!.hostId !== "flowmarshal-engine"
        || typeof pin!.publicKeySpki !== "string" || !DIGEST.test(String(pin!.hostBuildDigest))
        || !nonempty(pin!.modelPolicyVersion) || !["active", "revoked"].includes(String(pin!.status))
        || keys.has(pin!.keyId)
        || (installations.has(pin!.installationId as string)
          && installations.get(pin!.installationId as string) !== pin!.hostBuildDigest)) {
      fail("pin registry is malformed");
    }
    keys.add(pin!.keyId as string);
    installations.set(pin!.installationId as string, pin!.hostBuildDigest as string);
    const bytes = Buffer.from(pin!.publicKeySpki, "base64");
    if (bytes.toString("base64") !== pin!.publicKeySpki) fail("pin public key is malformed");
    try {
      const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
      if (key.asymmetricKeyType !== "ed25519") fail("pin public key is malformed");
    } catch { fail("pin public key is malformed"); }
  }
  for (const entry of raw!.hostBuilds as unknown[]) {
    const host = object(entry);
    if (!exact(host, ["hostId", "hostBuildDigest", "status"]) || host!.hostId !== "flowmarshal-engine"
        || !DIGEST.test(String(host!.hostBuildDigest)) || !["verified", "unverified"].includes(String(host!.status))
        || builds.has(host!.hostBuildDigest as string)) fail("host build registry is malformed");
    builds.add(host!.hostBuildDigest as string);
  }
  for (const entry of raw!.models as unknown[]) {
    const model = object(entry);
    if (!exact(model, ["hostId", "hostBuildDigest", "observedModelId", "modelClass", "status"])
        || model!.hostId !== "flowmarshal-engine" || !DIGEST.test(String(model!.hostBuildDigest))
        || !nonempty(model!.observedModelId) || !MODEL_CLASSES.includes(String(model!.modelClass))
        || !["verified", "unverified", "retired"].includes(String(model!.status))) fail("model registry is malformed");
    const identity = `${model!.hostId}\u0000${model!.hostBuildDigest}\u0000${model!.observedModelId}`;
    if (models.has(identity)) fail("duplicate model mapping");
    models.add(identity);
  }
  return raw as Policy;
}

type WindowsAcl = { owner: string; rules: Array<{ sid: string; rights: number; type: string }> };
export function isProtectedWindowsAcl(value: unknown): boolean {
  const acl = object(value);
  if (!acl || typeof acl.owner !== "string" || !SYSTEM_SIDS.has(acl.owner) || !Array.isArray(acl.rules)) return false;
  return acl.rules.every((entry: unknown) => {
    const rule = object(entry);
    if (!rule || typeof rule.sid !== "string" || !Number.isInteger(rule.rights) || typeof rule.type !== "string") return false;
    return rule.type !== "Allow" || SYSTEM_SIDS.has(rule.sid) || ((rule.rights as number) & ~WINDOWS_READ_RIGHTS) === 0;
  });
}

function inspectWindowsAcl(target: string): WindowsAcl {
  const script = `$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd(); `
    + `$a=if ([IO.Directory]::Exists($p)) { [IO.Directory]::GetAccessControl($p) } else { [IO.File]::GetAccessControl($p) }; `
    + `$owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value; `
    + `$rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { @{ sid=$_.IdentityReference.Value; rights=[int]$_.FileSystemRights; type=$_.AccessControlType.ToString() } }); `
    + `@{ owner=$owner; rules=$rules } | ConvertTo-Json -Compress -Depth 4`;
  try {
    const output = execFileSync(WINDOWS_POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], {
      input: target, encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true,
    });
    return JSON.parse(output) as WindowsAcl;
  } catch { fail("Windows ACL cannot be verified"); }
}

type PolicyFileFixture = { isProtected: (target: string, status: Stats) => boolean; afterValidation?: () => void };

function sameFile(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode
    && before.uid === after.uid && before.gid === after.gid && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
    && before.birthtimeMs === after.birthtimeMs;
}

function protectedByOperator(target: string, status: Stats): boolean {
  return process.platform === "win32"
    ? isProtectedWindowsAcl(inspectWindowsAcl(target))
    : status.uid === 0 && (status.mode & 0o022) === 0;
}

function readPolicyFile(filePath: string, fixture?: PolicyFileFixture): unknown {
  if (!path.isAbsolute(filePath)) fail("configuration path is not absolute");
  if (path.normalize(filePath) !== filePath) fail("configuration path is not canonical");
  const root = path.parse(filePath).root;
  const targets = [root];
  for (const part of path.relative(root, filePath).split(path.sep).filter(Boolean)) {
    targets.push(path.join(targets[targets.length - 1]!, part));
  }
  const snapshots = targets.map((target, index) => {
    let status: Stats;
    try { status = lstatSync(target); } catch { fail("configuration path is unavailable"); }
    if (status.isSymbolicLink() || (index === targets.length - 1 ? !status.isFile() : !status.isDirectory())) {
      fail("configuration path is not regular");
    }
    if (!(fixture?.isProtected ?? protectedByOperator)(target, status)) fail("configuration owner or permissions are unsafe");
    try { if (!sameFile(status, lstatSync(target))) fail("configuration changed during validation"); }
    catch { fail("configuration changed during validation"); }
    return status;
  });
  fixture?.afterValidation?.();
  let fd: number;
  try { fd = openSync(filePath, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)); }
  catch { fail("configuration changed before open"); }
  try {
    if (!sameFile(snapshots[snapshots.length - 1]!, fstatSync(fd))) fail("configuration changed before open");
    let value: unknown;
    try { value = JSON.parse(readFileSync(fd, "utf8")); } catch { fail("configuration JSON is malformed"); }
    if (!sameFile(snapshots[snapshots.length - 1]!, fstatSync(fd))) fail("configuration changed during read");
    for (const [index, target] of targets.entries()) {
      let status: Stats;
      try { status = lstatSync(target); } catch { fail("configuration changed during read"); }
      if (!sameFile(snapshots[index]!, status)) fail("configuration changed during read");
    }
    return value;
  } finally { closeSync(fd); }
}

export function readProtectedVmPolicyFile(filePath: string): unknown {
  return readPolicyFile(filePath);
}

/** Synthetic policy-file fixtures exercise path checks without requiring administrator privileges. */
export function readProtectedVmPolicyFileFixture(filePath: string, fixture: PolicyFileFixture): unknown {
  return readPolicyFile(filePath, fixture);
}

/** Product source is fixed; inherited VM environment, argv, and cwd cannot select it. */
export function installedVmPolicyPath(): string {
  return process.platform === "win32" ? WINDOWS_POLICY_PATH : POSIX_POLICY_PATH;
}

export class VmModelPolicy {
  private constructor(private readonly readPolicy: () => Policy) {}

  static installed(): VmModelPolicy | null {
    const filePath = installedVmPolicyPath();
    try { lstatSync(filePath); } catch { return null; }
    try {
      const policy = new VmModelPolicy(() => parsePolicy(readProtectedVmPolicyFile(filePath)));
      policy.readPolicy();
      return policy;
    } catch { return null; }
  }

  /** Only synthetic tests may inject an already trusted operator registry. */
  static fixture(value: unknown): VmModelPolicy {
    const policy = parsePolicy(value);
    return new VmModelPolicy(() => policy);
  }

  private pin(keyId: string, policy = this.readPolicy()): PinWithKey {
    const pin = policy.pins.find((entry) => entry.keyId === keyId);
    if (!pin || pin.status !== "active" || pin.modelPolicyVersion !== policy.modelPolicyVersion) fail("producer pin is revoked or policy version mismatches");
    const bytes = Buffer.from(pin.publicKeySpki, "base64");
    return { ...pin, key: createPublicKey({ key: bytes, format: "der", type: "spki" }) };
  }

  verifyEnvelope(envelopeValue: unknown): { body: JsonObject; bytes: Buffer; pin: PinWithKey } {
    const envelope = object(envelopeValue);
    if (!exact(envelope, ["body", "signature", "keyId"]) || !nonempty(envelope!.keyId)
        || typeof envelope!.body !== "string" || typeof envelope!.signature !== "string") fail("signed envelope is malformed");
    const pin = this.pin(envelope!.keyId);
    const bytes = Buffer.from(envelope!.body, "base64url");
    const signature = Buffer.from(envelope!.signature, "base64url");
    if (bytes.toString("base64url") !== envelope!.body || signature.toString("base64url") !== envelope!.signature
        || signature.length !== 64 || !verify(null, bytes, pin.key, signature)) fail("producer signature is invalid");
    let body: JsonObject | null = null;
    try { body = object(JSON.parse(bytes.toString("utf8"))); } catch { /* rejected below */ }
    if (!body || Buffer.from(canonicalJson(body), "utf8").compare(bytes) !== 0) fail("signed body is not canonical");
    const producer = object(body.producer);
    if (!producer || producer.keyId !== envelope!.keyId || producer.installationId !== pin.installationId
        || producer.hostId !== pin.hostId) fail("producer installation is not pinned");
    return { body, bytes, pin };
  }

  resolveProfile(registration: JsonObject): VmVerifiedProfile {
    const producer = object(registration.producer), terminal = object(registration.terminal);
    if (!producer || !terminal || !nonempty(producer.keyId) || !nonempty(terminal.model)) fail("observed model is unavailable");
    const policy = this.readPolicy();
    const pin = this.pin(producer.keyId, policy);
    if (producer.installationId !== pin.installationId || producer.hostId !== pin.hostId) fail("producer installation is not pinned");
    const build = policy.hostBuilds.find((entry) => entry.hostId === pin.hostId && entry.hostBuildDigest === pin.hostBuildDigest);
    const model = policy.models.find((entry) => entry.hostId === pin.hostId && entry.hostBuildDigest === pin.hostBuildDigest
      && entry.observedModelId === terminal.model);
    if (!build || build.status !== "verified" || !model || model.status !== "verified") fail("exact observed host model is unsupported");
    return { modelClass: model.modelClass, actorId: `vm-producer:${pin.installationId}`,
      observedModelId: model.observedModelId, installationId: pin.installationId,
      hostBuildDigest: pin.hostBuildDigest, modelPolicyVersion: policy.modelPolicyVersion };
  }
}
