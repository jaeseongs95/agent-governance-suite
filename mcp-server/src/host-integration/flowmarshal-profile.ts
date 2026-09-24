import { Ajv2020 } from "ajv/dist/2020.js";
import { execFileSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, type Stats } from "node:fs";
import path from "node:path";

import { convergenceDigest } from "../convergence-logic.js";
import { resolveFlowmarshalProfilePath } from "../runtime-config.js";
import { contractSchemas } from "../schema-validator.js";

const PROFILE_ID = "flowmarshal-same-user-v1";
const WINDOWS_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const schema = contractSchemas.hostIntegration;
const ajv = new Ajv2020().addSchema(schema);
const validateSelection = ajv.getSchema(`${String(schema.$id)}#/$defs/serverProfileSelection`)!;
const hasKeys = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const fail = (message: string): never => { throw new Error(`FlowMarshal same-user profile unavailable: ${message}`); };

type Pin = { keyId: string; publicKeySpki: string; status: "active" | "revoked" };
type PinSet = { namespace: typeof PROFILE_ID; pins: Pin[] };
type Resource = { namespace: typeof PROFILE_ID; location: string };
type Resources = { key: Resource; pin: Resource; state: Resource };
export type FlowmarshalProfile = Readonly<{
  profileId: typeof PROFILE_ID;
  assuranceTier: "same-user";
  freezeIdentity: string;
  pins: ReadonlyArray<Readonly<Pin>>;
  resources: Readonly<Resources>;
}>;

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid
    && a.gid === b.gid && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

export function isSameUserWindowsAcl(value: unknown): boolean {
  if (!hasKeys(value, ["self", "owner", "rules"]) || typeof value.self !== "string"
      || value.owner !== value.self || !Array.isArray(value.rules)) return false;
  return value.rules.every((entry: unknown) => {
    if (!hasKeys(entry, ["sid", "rights", "type"]) || typeof entry.sid !== "string"
        || !Number.isInteger(entry.rights) || !["Allow", "Deny"].includes(String(entry.type))) return false;
    return entry.type === "Deny" || entry.sid === value.self
      || entry.sid === "S-1-5-18" || entry.sid === "S-1-5-32-544";
  });
}

function sameUserWindowsAcl(file: string): boolean {
  const script = `$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd(); `
    + `$a=if ([IO.Directory]::Exists($p)) { [IO.Directory]::GetAccessControl($p) } else { [IO.File]::GetAccessControl($p) }; `
    + `$self=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; `
    + `$rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { @{ sid=$_.IdentityReference.Value; rights=[int]$_.FileSystemRights; type=$_.AccessControlType.ToString() } }); `
    + `@{ self=$self; owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value; rules=$rules } | ConvertTo-Json -Compress -Depth 4`;
  try {
    const output = execFileSync(WINDOWS_POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], {
      input: file, encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true,
    });
    return isSameUserWindowsAcl(JSON.parse(output));
  } catch { return false; }
}

function inspectFile(file: string, required: boolean): Stats | null {
  let status: Stats;
  try { status = lstatSync(file); }
  catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return fail(`missing or unreadable file: ${path.basename(file)}`);
  }
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) fail(`unsafe file: ${path.basename(file)}`);
  if (process.platform !== "win32" && (status.uid !== process.getuid?.() || (status.mode & 0o077) !== 0)) {
    fail(`permissions are too broad: ${path.basename(file)}`);
  }
  if (process.platform === "win32" && !sameUserWindowsAcl(file)) fail(`permissions are too broad: ${path.basename(file)}`);
  return status;
}

function readTrustedJson(file: string): unknown {
  const before = inspectFile(file, true)!;
  if (before.size > 1024 * 1024) fail(`file is too large: ${path.basename(file)}`);
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)); }
  catch { return fail(`file changed before open: ${path.basename(file)}`); }
  try {
    if (!sameFile(before, fstatSync(fd))) fail(`file changed before read: ${path.basename(file)}`);
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(fd, "utf8")); }
    catch { return fail(`invalid JSON: ${path.basename(file)}`); }
    if (!sameFile(before, fstatSync(fd)) || !sameFile(before, inspectFile(file, true)!)) {
      fail(`file changed during read: ${path.basename(file)}`);
    }
    return parsed;
  } finally { closeSync(fd); }
}

function parsePins(value: unknown): PinSet {
  if (!hasKeys(value, ["namespace", "pins"]) || value.namespace !== PROFILE_ID
      || !Array.isArray(value.pins) || value.pins.length === 0) fail("pin set is malformed");
  const pinSet = value as PinSet;
  const seen = new Set<string>();
  let active = false;
  for (const item of pinSet.pins) {
    if (!hasKeys(item, ["keyId", "publicKeySpki", "status"])
        || typeof item.keyId !== "string" || !item.keyId.trim() || seen.has(item.keyId)
        || typeof item.publicKeySpki !== "string" || !item.publicKeySpki
        || !["active", "revoked"].includes(String(item.status))) fail("pin set is malformed");
    const bytes = Buffer.from(item.publicKeySpki, "base64");
    if (bytes.toString("base64") !== item.publicKeySpki) fail("pin public key is malformed");
    try {
      if (createPublicKey({ key: bytes, format: "der", type: "spki" }).asymmetricKeyType !== "ed25519") {
        fail("pin public key is not Ed25519");
      }
    } catch { fail("pin public key is malformed"); }
    seen.add(item.keyId);
    active ||= item.status === "active";
  }
  if (!active) fail("no active producer pin");
  return pinSet;
}

/** Server-owned A2 loader. It never opens the FM private key or the FM ledger/transcript. */
export function loadFlowmarshalProfileFile(profilePath: string): FlowmarshalProfile | null {
  try { lstatSync(profilePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return fail("profile file is unreadable");
  }
  const directory = path.dirname(profilePath);
  const dir = lstatSync(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink()) fail("profile directory is unsafe");
  if (process.platform !== "win32" && (dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0)) {
    fail("profile directory permissions are too broad");
  }
  if (process.platform === "win32" && !sameUserWindowsAcl(directory)) fail("profile directory permissions are too broad");
  const resources: Resources = {
    key: { namespace: PROFILE_ID, location: path.join(directory, "producer-key.json") },
    pin: { namespace: PROFILE_ID, location: path.join(directory, "pins.json") },
    state: { namespace: PROFILE_ID, location: path.join(directory, "state.sqlite3") },
  };
  const document = readTrustedJson(profilePath);
  if (!hasKeys(document, ["version", "selection", "resources"]) || document.version !== 1
      || !validateSelection(document.selection) || !hasKeys(document.selection, ["source", "profile", "pinSetDigest", "resourceBindingDigest", "freezeIdentity"])
      || !hasKeys(document.resources, ["key", "pin", "state"])
      || convergenceDigest(document.resources) !== convergenceDigest(resources)) fail("selection or resources are malformed");
  const selected = (document as { selection: Record<string, unknown> }).selection;
  if (!hasKeys(selected.profile, ["profileId", "assuranceTier", "hostId", "receiptDomain", "dispatchDomain", "modelClassSource", "actorSource", "keyNamespace", "pinNamespace", "stateNamespace"])
      || selected.profile.profileId !== PROFILE_ID || selected.profile.assuranceTier !== "same-user") {
    fail("protected VM profile cannot be selected");
  }
  const { freezeIdentity, ...selectionBody } = selected;
  if (freezeIdentity !== convergenceDigest(selectionBody)
      || selected.resourceBindingDigest !== convergenceDigest(resources)) fail("profile freeze identity is invalid");
  inspectFile(resources.key.location, true); // Presence and ownership only; AGS does not read the private key.
  inspectFile(resources.state.location, false); // F03 may create the state DB later.
  const pins = parsePins(readTrustedJson(resources.pin.location));
  if (selected.pinSetDigest !== convergenceDigest(pins)) fail("pin set digest is invalid");
  return Object.freeze({ profileId: PROFILE_ID, assuranceTier: "same-user", freezeIdentity: String(freezeIdentity),
    pins: Object.freeze(pins.pins.map((pin) => Object.freeze({ ...pin }))),
    resources: Object.freeze({
      key: Object.freeze(resources.key), pin: Object.freeze(resources.pin), state: Object.freeze(resources.state),
    }),
  });
}

let initialized = false;
let installedProfile: FlowmarshalProfile | null = null;

/** The installed path is fixed and the result (including absence) freezes for this server process. */
export function initializeFlowmarshalProfile(): FlowmarshalProfile | null {
  if (!initialized) {
    installedProfile = loadFlowmarshalProfileFile(resolveFlowmarshalProfilePath());
    initialized = true;
  }
  return installedProfile;
}

/** F03 must consume this startup snapshot, never reselect from an MCP request or environment. */
export function currentFlowmarshalProfile(): FlowmarshalProfile | null {
  if (!initialized) fail("server profile was not initialized");
  return installedProfile;
}
