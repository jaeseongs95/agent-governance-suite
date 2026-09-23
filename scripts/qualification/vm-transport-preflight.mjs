import { createPrivateKey, createPublicKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

const WINDOWS = {
  key: 'C:\\ProgramData\\flowmarshal\\ags-producer-key.json',
  pin: 'C:\\ProgramData\\agent-governance-suite\\vm-operator-policy.json',
};
const LINUX = {
  key: '/etc/flowmarshal/ags-producer-key.json',
  pin: '/etc/agent-governance-suite/vm-operator-policy.json',
};
const SYSTEM_SIDS = new Set(['S-1-5-18', 'S-1-5-32-544']);
const TRUSTED_INSTALLER_SID = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
const WINDOWS_READ_RIGHTS = 0x1200a9;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function windowsAcl(target) {
  const script = `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())); `
    + `$a=if ([IO.Directory]::Exists($p)) { [IO.Directory]::GetAccessControl($p) } else { [IO.File]::GetAccessControl($p) }; `
    + `$owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value; `
    + `$rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { @{ sid=$_.IdentityReference.Value; rights=[int]$_.FileSystemRights; type=$_.AccessControlType.ToString() } }); `
    + `$id=[Security.Principal.WindowsIdentity]::GetCurrent(); $principal=New-Object Security.Principal.WindowsPrincipal($id); `
    + `$active=@($id.User.Value); foreach ($rule in $rules) { if ($principal.IsInRole((New-Object Security.Principal.SecurityIdentifier($rule.sid)))) { $active += $rule.sid } }; `
    + `$execAllow=$false; $execDeny=$false; foreach ($rule in $rules) { if (($active -contains $rule.sid) -and (($rule.rights -band 32) -ne 0)) { if ($rule.type -eq 'Deny') { $execDeny=$true } else { $execAllow=$true } } }; `
    + `@{ owner=$owner; rules=$rules; canExecute=($execAllow -and -not $execDeny); reparse=([bool]([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint)) } | ConvertTo-Json -Compress -Depth 4`;
  return JSON.parse(execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: Buffer.from(target, 'utf16le').toString('base64'), encoding: 'utf8',
    timeout: 5000, maxBuffer: 64 * 1024,
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  }));
}

export function protectedWindowsAcl(acl, secretFile, candidate = false) {
  return !!acl && (SYSTEM_SIDS.has(acl.owner) || (candidate && acl.owner === TRUSTED_INSTALLER_SID))
    && acl.reparse === false && Array.isArray(acl.rules)
    && acl.rules.every((rule) => rule && typeof rule.sid === 'string'
      && Number.isInteger(rule.rights) && ['Allow', 'Deny'].includes(rule.type)
      && (rule.type !== 'Allow' || SYSTEM_SIDS.has(rule.sid)
        || (candidate && rule.sid === TRUSTED_INSTALLER_SID)
        || (rule.rights & ~(secretFile ? 0 : WINDOWS_READ_RIGHTS)) === 0));
}

function sameFile(a, b, contents = false) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
    && a.uid === b.uid && a.gid === b.gid
    && (!contents || (a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs));
}

export function inspectFile(filePath, {
  secret = false, protectedFile = false, candidate = false, protection, execution,
} = {}) {
  if (!path.isAbsolute(filePath) || path.normalize(filePath) !== filePath) {
    return { ok: false, code: 'PATH_INVALID' };
  }
  const root = path.parse(filePath).root;
  const targets = [root];
  for (const part of path.relative(root, filePath).split(path.sep).filter(Boolean)) {
    targets.push(path.join(targets.at(-1), part));
  }
  const snapshots = [];
  for (const [index, target] of targets.entries()) {
    const isFile = index === targets.length - 1;
    let status;
    try { status = lstatSync(target); } catch { return { ok: false, code: 'PATH_MISSING', at: target }; }
    if (status.isSymbolicLink() || (isFile ? !status.isFile() : !status.isDirectory())) {
      return { ok: false, code: 'PATH_REPARSE_OR_TYPE', at: target };
    }
    snapshots.push(status);
  }
  for (const [index, target] of targets.entries()) {
    const isFile = index === targets.length - 1;
    const status = snapshots[index];
    let acl;
    if (process.platform === 'win32' && !protection) {
      try { acl = windowsAcl(target); }
      catch { return { ok: false, code: 'PATH_METADATA_UNVERIFIABLE', at: target }; }
      if (acl.reparse !== false) return { ok: false, code: 'PATH_REPARSE_OR_TYPE', at: target };
    }
    if (protectedFile) {
      let allowed;
      try {
        allowed = protection ? protection(target, status, secret && isFile, candidate)
          : process.platform === 'win32'
            ? protectedWindowsAcl(acl, secret && isFile, candidate)
            : status.uid === 0 && (status.mode & (secret && isFile ? 0o077 : 0o022)) === 0;
      } catch { return { ok: false, code: 'PROTECTION_UNVERIFIABLE', at: target }; }
      if (!allowed) return { ok: false, code: 'OWNER_OR_ACL_UNSAFE', at: target };
    }
    if (candidate && isFile) {
      try {
        if (execution) {
          if (!execution(target, status)) return { ok: false, code: 'NOT_EXECUTABLE', at: target };
        } else if (process.platform === 'win32') {
          if (!['.exe', '.com'].includes(path.extname(target).toLowerCase()) || acl?.canExecute !== true) {
            return { ok: false, code: 'NOT_EXECUTABLE', at: target };
          }
        } else {
          if ((status.mode & 0o111) === 0) return { ok: false, code: 'NOT_EXECUTABLE', at: target };
          accessSync(target, constants.X_OK);
        }
      } catch { return { ok: false, code: 'NOT_EXECUTABLE', at: target }; }
    }
    try {
      if (!sameFile(status, lstatSync(target), isFile)) return { ok: false, code: 'PATH_CHANGED', at: target };
    } catch { return { ok: false, code: 'PATH_CHANGED', at: target }; }
  }
  return { ok: true, targets, snapshots };
}

function parseUniqueJson(raw) {
  let index = 0;
  const space = () => { while (/[\t\n\r ]/u.test(raw[index] ?? '')) index += 1; };
  const string = () => {
    if (raw[index] !== '"') throw new Error('string expected');
    const start = index++;
    while (index < raw.length) {
      if (raw[index] === '\\') index += 2;
      else if (raw[index++] === '"') return JSON.parse(raw.slice(start, index));
    }
    throw new Error('string incomplete');
  };
  const value = (depth = 0) => {
    if (depth > 64) throw new Error('JSON too deep');
    space();
    if (raw[index] === '{') {
      index += 1;
      const keys = new Set();
      space();
      if (raw[index] === '}') { index += 1; return; }
      while (true) {
        space();
        const key = string();
        if (keys.has(key)) throw new Error('duplicate key');
        keys.add(key);
        space();
        if (raw[index++] !== ':') throw new Error('colon expected');
        value(depth + 1);
        space();
        const next = raw[index++];
        if (next === '}') return;
        if (next !== ',') throw new Error('object delimiter expected');
      }
    }
    if (raw[index] === '[') {
      index += 1;
      space();
      if (raw[index] === ']') { index += 1; return; }
      while (true) {
        value(depth + 1);
        space();
        const next = raw[index++];
        if (next === ']') return;
        if (next !== ',') throw new Error('array delimiter expected');
      }
    }
    if (raw[index] === '"') { string(); return; }
    const start = index;
    while (index < raw.length && !/[,}\]\t\n\r ]/u.test(raw[index])) index += 1;
    if (index === start) throw new Error('value expected');
  };
  value();
  space();
  if (index !== raw.length) throw new Error('trailing JSON');
  return JSON.parse(raw);
}

function readCheckedJson(filePath, inspection) {
  let fd;
  try {
    fd = openSync(filePath, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
    if (!sameFile(inspection.snapshots.at(-1), fstatSync(fd), true)) return null;
    const bytes = Buffer.alloc(1_048_577);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > 1_048_576 || !sameFile(inspection.snapshots.at(-1), fstatSync(fd), true)) return null;
    if (inspection.targets.some((target, index) => !sameFile(inspection.snapshots[index],
      lstatSync(target), index === inspection.targets.length - 1))) return null;
    return parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }

export function checkInstallation(key, policy, observedModel) {
  const blocked = (code) => ({ ok: false, code });
  if (!exact(key, ['version', 'installationId', 'keyId', 'hostId', 'modelPolicyVersion', 'privateKeyPkcs8'])
    || key.version !== 1 || key.hostId !== 'flowmarshal-engine'
    || !['installationId', 'keyId', 'modelPolicyVersion', 'privateKeyPkcs8'].every((field) => typeof key[field] === 'string' && key[field])) {
    return blocked('KEY_FORMAT_INVALID');
  }
  if (!exact(policy, ['version', 'modelPolicyVersion', 'pins', 'hostBuilds', 'models'])
    || policy.version !== 1 || !Array.isArray(policy.pins) || !Array.isArray(policy.hostBuilds)
    || !Array.isArray(policy.models) || !nonempty(policy.modelPolicyVersion)
    || policy.modelPolicyVersion !== key.modelPolicyVersion) {
    return blocked('POLICY_VERSION_OR_FORMAT_INVALID');
  }
  const keyIds = new Set(), installations = new Map(), buildsSeen = new Set(), modelsSeen = new Set();
  for (const entry of policy.pins) {
    if (!exact(entry, ['keyId', 'installationId', 'hostId', 'publicKeySpki', 'hostBuildDigest', 'modelPolicyVersion', 'status'])
      || !nonempty(entry.keyId) || !nonempty(entry.installationId) || entry.hostId !== 'flowmarshal-engine'
      || !DIGEST.test(entry.hostBuildDigest) || !nonempty(entry.modelPolicyVersion)
      || !['active', 'revoked'].includes(entry.status) || keyIds.has(entry.keyId)
      || (installations.has(entry.installationId) && installations.get(entry.installationId) !== entry.hostBuildDigest)) {
      return blocked('POLICY_PIN_REGISTRY_INVALID');
    }
    try {
      const raw = Buffer.from(entry.publicKeySpki, 'base64');
      if (raw.toString('base64') !== entry.publicKeySpki
        || createPublicKey({ key: raw, format: 'der', type: 'spki' }).asymmetricKeyType !== 'ed25519') {
        return blocked('POLICY_PIN_REGISTRY_INVALID');
      }
    } catch { return blocked('POLICY_PIN_REGISTRY_INVALID'); }
    keyIds.add(entry.keyId);
    installations.set(entry.installationId, entry.hostBuildDigest);
  }
  for (const entry of policy.hostBuilds) {
    if (!exact(entry, ['hostId', 'hostBuildDigest', 'status']) || entry.hostId !== 'flowmarshal-engine'
      || !DIGEST.test(entry.hostBuildDigest) || !['verified', 'unverified'].includes(entry.status)
      || buildsSeen.has(entry.hostBuildDigest)) return blocked('POLICY_BUILD_REGISTRY_INVALID');
    buildsSeen.add(entry.hostBuildDigest);
  }
  for (const entry of policy.models) {
    const identity = `${entry?.hostId}\0${entry?.hostBuildDigest}\0${entry?.observedModelId}`;
    if (!exact(entry, ['hostId', 'hostBuildDigest', 'observedModelId', 'modelClass', 'status'])
      || entry.hostId !== 'flowmarshal-engine' || !DIGEST.test(entry.hostBuildDigest)
      || !nonempty(entry.observedModelId) || !['lightweight', 'general', 'deep', 'frontier'].includes(entry.modelClass)
      || !['verified', 'unverified', 'retired'].includes(entry.status) || modelsSeen.has(identity)) {
      return blocked('POLICY_MODEL_REGISTRY_INVALID');
    }
    modelsSeen.add(identity);
  }
  const pins = policy.pins.filter((entry) => entry?.keyId === key.keyId);
  if (pins.length !== 1) return blocked('PIN_MISSING_OR_DUPLICATE');
  const pin = pins[0];
  if (!exact(pin, ['keyId', 'installationId', 'hostId', 'publicKeySpki', 'hostBuildDigest', 'modelPolicyVersion', 'status'])
    || pin.installationId !== key.installationId || pin.hostId !== key.hostId
    || pin.modelPolicyVersion !== key.modelPolicyVersion || pin.status !== 'active'
    || !DIGEST.test(pin.hostBuildDigest) || typeof pin.publicKeySpki !== 'string') {
    return blocked('PIN_REVOKED_OR_MISMATCHED');
  }
  try {
    const encoded = Buffer.from(key.privateKeyPkcs8, 'base64');
    if (encoded.toString('base64') !== key.privateKeyPkcs8) return blocked('KEY_FORMAT_INVALID');
    const privateKey = createPrivateKey({ key: encoded, format: 'der', type: 'pkcs8' });
    const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.toString('base64') !== pin.publicKeySpki) {
      return blocked('KEY_PIN_MISMATCH');
    }
  } catch { return blocked('KEY_FORMAT_INVALID'); }
  const builds = policy.hostBuilds.filter((entry) => entry?.hostId === key.hostId
    && entry?.hostBuildDigest === pin.hostBuildDigest && entry?.status === 'verified');
  if (builds.length !== 1) return blocked('HOST_BUILD_NOT_VERIFIED_IN_POLICY');
  if (!observedModel) return blocked('EXACT_MODEL_INPUT_MISSING');
  const models = policy.models.filter((entry) => entry?.hostId === key.hostId
    && entry?.hostBuildDigest === pin.hostBuildDigest && entry?.observedModelId === observedModel
    && entry?.status === 'verified');
  if (models.length !== 1) return blocked('EXACT_MODEL_NOT_VERIFIED_IN_POLICY');
  return { ok: true, installationId: key.installationId, keyId: key.keyId,
    hostId: key.hostId, hostBuildDigest: pin.hostBuildDigest,
    modelPolicyVersion: key.modelPolicyVersion, exactModelId: observedModel };
}

function runtimePrincipal() {
  if (process.platform !== 'win32') return { uid: process.getuid(), euid: process.geteuid() };
  try {
    const sid = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command',
      '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    }).trim();
    return { sid };
  } catch { return { sid: null }; }
}

export function preflight({ paths, vmEntry, agsEntry, observedModel, protection, execution } = {}) {
  const selectedPaths = paths ?? (process.platform === 'win32' ? WINDOWS : LINUX);
  const fixture = !!(paths || protection || execution);
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : 'unsupported';
  const checks = {};
  const missingInputs = [];
  for (const [name, filePath] of Object.entries({ key: selectedPaths.key, pin: selectedPaths.pin })) {
    const inspection = inspectFile(filePath, { secret: name === 'key', protectedFile: true, protection });
    checks[name] = inspection.ok ? { ok: true } : inspection;
    if (!inspection.ok) missingInputs.push(`${name}:${inspection.code}`);
  }
  for (const [name, filePath] of Object.entries({ vmEntry, agsEntry })) {
    if (!filePath) { checks[name] = { ok: false, code: 'INPUT_MISSING' }; missingInputs.push(name); continue; }
    const inspection = inspectFile(filePath, { protectedFile: true, candidate: true, protection, execution });
    checks[name] = inspection.ok ? { ok: true, candidateOnly: true } : inspection;
    if (!inspection.ok) missingInputs.push(`${name}:${inspection.code}`);
  }
  if (!observedModel) missingInputs.push('observedModel');
  let policy = { ok: false, code: 'PROTECTED_INPUTS_UNAVAILABLE' };
  if (checks.key.ok && checks.pin.ok) {
    const key = readCheckedJson(selectedPaths.key, inspectFile(selectedPaths.key, {
      secret: true, protectedFile: true, protection,
    }));
    const pin = readCheckedJson(selectedPaths.pin, inspectFile(selectedPaths.pin, {
      protectedFile: true, protection,
    }));
    policy = key && pin ? checkInstallation(key, pin, observedModel) : { ok: false, code: 'PROTECTED_JSON_UNREADABLE' };
    if (!policy.ok) missingInputs.push(`policy:${policy.code}`);
  }
  return {
    status: missingInputs.length || os === 'unsupported' ? 'BLOCKED_CONTRACT'
      : fixture ? 'FIXTURE_ONLY' : 'READY_FOR_QUALIFICATION',
    evidenceOrigin: fixture ? 'synthetic-fixture' : 'installed-preflight',
    currentOs: os, runtimePrincipal: runtimePrincipal(),
    osExecution: { windows: os === 'windows' ? 'PREFLIGHT_EXECUTED' : 'SEPARATE_HOST_REQUIRED',
      linux: os === 'linux' ? 'PREFLIGHT_EXECUTED' : 'SEPARATE_HOST_REQUIRED' },
    checks, policy, missingInputs,
    qualification: { hostSupported: 'unknown',
      configured: policy.ok && !fixture ? 'preflight-only' : 'unconfirmed', observed: false },
    remainingQualification: ['operator-measured installed VM build and AGS build',
      'actual CoreOperations → vm/hello → vm/reserve_dispatch → tools/call run',
      'separate Windows and Linux runs with independent evidence'],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  const allowed = new Set(['--vm-entry', '--ags-entry', '--observed-model']);
  if (args.length % 2 !== 0 || args.some((arg, index) => index % 2 === 0 ? !allowed.has(arg) : !arg)
    || new Set(args.filter((_, index) => index % 2 === 0)).size !== args.length / 2) {
    process.stderr.write('Usage: node vm-transport-preflight.mjs --vm-entry ABSOLUTE_PATH --ags-entry ABSOLUTE_PATH --observed-model EXACT_ID\n');
    process.exitCode = 2;
  } else {
    const report = preflight({ vmEntry: value('--vm-entry'), agsEntry: value('--ags-entry'),
      observedModel: value('--observed-model') });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== 'READY_FOR_QUALIFICATION') process.exitCode = 1;
  }
}
