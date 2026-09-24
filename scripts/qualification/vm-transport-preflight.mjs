import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

const WINDOWS = {
  key: 'C:\\ProgramData\\flowmarshal\\ags-producer-key.json',
  pin: 'C:\\ProgramData\\agent-governance-suite\\vm-operator-policy.json',
  installation: 'C:\\ProgramData\\flowmarshal\\protected-installation.json',
};
const LINUX = {
  key: '/etc/flowmarshal/ags-producer-key.json',
  pin: '/etc/agent-governance-suite/vm-operator-policy.json',
  installation: '/etc/flowmarshal/protected-installation.json',
};
const SYSTEM_SIDS = new Set(['S-1-5-18', 'S-1-5-32-544']);
const TRUSTED_INSTALLER_SID = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
const WINDOWS_READ_RIGHTS = 0x1200a9;
const WINDOWS_CREATE_CHILD_RIGHTS = 0x6;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
export const PROTECTED_HOST_CONTRACT = Object.freeze({
  id: 'ags-vm-protected-host-installation/v1',
  revision: '1',
  manifestSha256: 'sha256:0c5bfc700c37cd22b7c15c06f00c916948f1b170a7a0f8cd9da7768eb39ccb19',
  profilesSha256: 'sha256:fdd8677983d4aaf3d4d2ae8809a009a48643f5f047a4787b7940c5f4701d4b82',
});

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

export function protectedWindowsAcl(acl, secretFile, candidate = false, systemParent = false) {
  return !!acl && (SYSTEM_SIDS.has(acl.owner) || ((candidate || systemParent) && acl.owner === TRUSTED_INSTALLER_SID))
    && acl.reparse === false && Array.isArray(acl.rules)
    && acl.rules.every((rule) => rule && typeof rule.sid === 'string'
      && Number.isInteger(rule.rights) && ['Allow', 'Deny'].includes(rule.type)
      && (rule.type !== 'Allow' || SYSTEM_SIDS.has(rule.sid)
        || ((candidate || systemParent) && rule.sid === TRUSTED_INSTALLER_SID)
        || (rule.rights & ~(secretFile ? 0 : WINDOWS_READ_RIGHTS
          | (systemParent ? WINDOWS_CREATE_CHILD_RIGHTS : 0))) === 0));
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
        const systemParent = process.platform === 'win32'
          ? target === 'C:\\' || target === 'C:\\ProgramData' || target === 'C:\\Program Files'
          : target === '/' || target === '/etc';
        allowed = protection ? protection(target, status, secret && isFile, candidate)
          : process.platform === 'win32'
            ? protectedWindowsAcl(acl, secret && isFile, candidate, systemParent)
            : status.uid === 0 && (status.mode & (candidate || systemParent ? 0o022 : 0o077)) === 0;
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

function readCheckedJson(filePath, inspection, options) {
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
    const repeated = inspectFile(filePath, options);
    if (!repeated.ok || repeated.snapshots.some((status, index) => !sameFile(
      inspection.snapshots[index], status, index === repeated.snapshots.length - 1))) return null;
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

const fixtureProfilesPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/coordinate-subagents/v3x/fixtures/protected-host-installation/profiles.json');

export function evaluateProtectedHostFixture(observation, os) {
  let baseline;
  try {
    const bytes = readFileSync(fixtureProfilesPath);
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== PROTECTED_HOST_CONTRACT.profilesSha256) {
      return { status: 'UNKNOWN', code: 'FIXTURE_DIGEST_MISMATCH' };
    }
    const profiles = JSON.parse(bytes.toString('utf8'));
    if (profiles.contractId !== PROTECTED_HOST_CONTRACT.id || profiles.revision !== PROTECTED_HOST_CONTRACT.revision) {
      return { status: 'UNKNOWN', code: 'FIXTURE_REVISION_MISMATCH' };
    }
    baseline = profiles[os];
  } catch { return { status: 'UNKNOWN', code: 'FIXTURE_UNAVAILABLE' }; }
  try {
    if (!baseline || !observation || observation.principals.worker.observed !== true
      || observation.coreBinding.oneShotRequest == null) {
      return { status: 'UNKNOWN', code: 'CHILD_OR_IPC_UNOBSERVED' };
    }
    const requiredProbes = Object.keys(baseline.accessProbes);
    if (!observation.accessProbes || requiredProbes.some((name) => !Object.hasOwn(observation.accessProbes, name))) {
      return { status: 'UNKNOWN', code: 'ACCESS_PROBES_MISSING' };
    }
    if (observation.principals.worker.id === observation.principals.core.id
      || Object.keys(observation.accessProbes).length !== requiredProbes.length
      || requiredProbes.some((name) => observation.accessProbes[name] !== 'DENIED')
      || !observation.coreBinding.currentPreparedOperation
      || !observation.coreBinding.oneShotRequest || observation.coreBinding.callerOverride
      || !observation.objects.launcher.measuredClosure) {
      return { status: 'REJECT', code: 'PRINCIPAL_OR_BINDING_UNSAFE' };
    }
    const worker = observation.principals.worker;
    if (os === 'windows'
      ? worker.integrity !== 'low' || !Array.isArray(worker.groups)
        || JSON.stringify(worker.groups) !== JSON.stringify(baseline.principals.worker.groups)
        || !Array.isArray(worker.enabledPrivileges)
        || worker.enabledPrivileges.length !== 0
      : worker.noNewPrivs !== true || !Array.isArray(worker.capabilities)
        || worker.capabilities.length !== 0 || !Array.isArray(worker.supplementaryGroups)
        || worker.supplementaryGroups.length !== 0) {
      return { status: 'REJECT', code: 'WORKER_PRIVILEGE_UNSAFE' };
    }
    const chains = baseline.protectedChains;
    if (JSON.stringify(observation.protectedChains) !== JSON.stringify(chains)) {
      return { status: 'REJECT', code: 'PROTECTED_CHAIN_CHANGED' };
    }
    for (const chain of Object.values(chains)) for (const name of chain) {
      const item = observation.objects[name], prior = baseline.objects[name];
      if (!item || item.path !== prior.path || item.identity !== prior.identity || item.owner !== prior.owner
        || item.aclChanged || item.reparseOrSymlink || item.reparse || item.symlink
        || (os === 'linux' && ((Number.parseInt(item.mode, 8) & 0o022) !== 0 || item.mode !== prior.mode))) {
        return { status: 'REJECT', code: 'PROTECTED_CHAIN_UNSAFE' };
      }
      const rights = item.workerEffective;
      if (!rights || ['write', 'delete', 'replace', 'deleteChild', 'writeDac', 'writeOwner']
        .some((right) => rights[right] !== false)
        || (os === 'linux' && rights.createChild !== false)
        || (os === 'windows' && !['systemRoot', 'systemParent', 'programFiles'].includes(name)
          && rights.createChild !== false)
        || (['key', 'pin', 'coreState'].includes(name) && rights.read !== false)) {
        return { status: 'REJECT', code: 'PROTECTED_RIGHTS_UNSAFE' };
      }
    }
    if (observation.installationRecord.contractRevision !== PROTECTED_HOST_CONTRACT.revision
      || observation.installationRecord.workerCanReplace !== false) {
      return { status: 'REJECT', code: 'INSTALLATION_RECORD_UNSAFE' };
    }
    return { status: 'CONTRACT_CANDIDATE_FIXTURE', code: 'SYNTHETIC_ONLY' };
  } catch { return { status: 'UNKNOWN', code: 'OBSERVATION_INCOMPLETE' }; }
}

export function checkProtectedInstallationRecord(value, os, principalId) {
  const fixed = os === 'windows' ? WINDOWS : LINUX;
  const coreState = os === 'windows' ? 'C:\\ProgramData\\flowmarshal\\core-state' : '/var/lib/flowmarshal/core-state';
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const paths = record?.paths, principals = record?.principals;
  const ids = ['installer', 'core', 'ags', 'worker'].map((role) => principals?.[role]?.id);
  const worker = principals?.worker;
  const pathApi = os === 'windows' ? path.win32 : path.posix;
  return !!record && record.contractId === PROTECTED_HOST_CONTRACT.id
    && record.revision === PROTECTED_HOST_CONTRACT.revision
    && record.fixtureSha256 === PROTECTED_HOST_CONTRACT.manifestSha256
    && record.os === os && paths?.key === fixed.key && paths?.pin === fixed.pin
    && paths?.coreState === coreState && ids.every((id) => typeof id === 'string' && id.length > 0)
    && ids[2] === principalId && ids[3] !== ids[1] && ids[3] !== ids[2]
    && (os === 'windows'
      ? worker.integrity === 'low' && Array.isArray(worker.groups)
        && worker.groups.every((group) => group === 'S-1-5-32-545')
        && Array.isArray(worker.enabledPrivileges) && worker.enabledPrivileges.length === 0
      : worker.id !== 'uid:0' && worker.noNewPrivs === true
        && Array.isArray(worker.capabilities) && worker.capabilities.length === 0
        && Array.isArray(worker.supplementaryGroups) && worker.supplementaryGroups.length === 0)
    && ['agsState', 'vmEntry', 'agsEntry'].every((name) => typeof paths[name] === 'string'
      && pathApi.isAbsolute(paths[name]) && pathApi.normalize(paths[name]) === paths[name])
    && paths.agsState.startsWith(`${coreState}${pathApi.sep}`)
    && typeof paths.workerEndpoint === 'string' && paths.workerEndpoint.length > 0
    && ['core', 'worker'].every((name) => typeof record.services?.[name] === 'string' && record.services[name])
    && ['vm', 'ags'].every((name) => DIGEST.test(record.buildDigests?.[name]))
    && DIGEST.test(record.launcherClosureDigest);
}

function runtimePrincipal() {
  if (process.platform !== 'win32') return { id: process.getuid() === process.geteuid()
    ? `uid:${process.geteuid()}` : null, uid: process.getuid(), euid: process.geteuid() };
  try {
    const sid = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command',
      '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    }).trim();
    return { id: sid, sid };
  } catch { return { id: null, sid: null }; }
}

export function preflight({ paths, vmEntry, agsEntry, observedModel, protection, execution, fixtureObservation } = {}) {
  const selectedPaths = paths ?? (process.platform === 'win32' ? WINDOWS : LINUX);
  const fixture = !!(paths || protection || execution || fixtureObservation);
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : 'unsupported';
  const principal = runtimePrincipal();
  const checks = {};
  const missingInputs = [];
  for (const [name, filePath] of Object.entries({ key: selectedPaths.key, pin: selectedPaths.pin })) {
    const inspection = inspectFile(filePath, { secret: true, protectedFile: true, protection });
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
    const keyOptions = { secret: true, protectedFile: true, protection };
    const pinOptions = { secret: true, protectedFile: true, protection };
    const keyInspection = inspectFile(selectedPaths.key, keyOptions);
    const pinInspection = inspectFile(selectedPaths.pin, pinOptions);
    const key = keyInspection.ok ? readCheckedJson(selectedPaths.key, keyInspection, keyOptions) : null;
    const pin = pinInspection.ok ? readCheckedJson(selectedPaths.pin, pinInspection, pinOptions) : null;
    policy = key && pin ? checkInstallation(key, pin, observedModel) : { ok: false, code: 'PROTECTED_JSON_UNREADABLE' };
    if (!policy.ok) missingInputs.push(`policy:${policy.code}`);
  }
  let hostBoundary = { status: 'UNKNOWN', code: 'CHILD_PRINCIPAL_NOT_OBSERVED' };
  if (fixtureObservation) {
    hostBoundary = evaluateProtectedHostFixture(fixtureObservation.profile, fixtureObservation.os);
    if (hostBoundary.status !== 'CONTRACT_CANDIDATE_FIXTURE') missingInputs.push(`hostBoundary:${hostBoundary.code}`);
  }
  if (!fixture) {
    const inspection = inspectFile(selectedPaths.installation, { secret: true, protectedFile: true });
    checks.installation = inspection.ok ? { ok: true } : inspection;
    if (!inspection.ok) missingInputs.push(`installation:${inspection.code}`);
    else {
      const record = readCheckedJson(selectedPaths.installation, inspection,
        { secret: true, protectedFile: true });
      checks.installation = record && checkProtectedInstallationRecord(record, os, principal.id)
        && record.paths.vmEntry === vmEntry && record.paths.agsEntry === agsEntry
        ? { ok: true, contractOnly: true }
        : { ok: false, code: 'INSTALLATION_RECORD_UNVERIFIED' };
      if (!checks.installation.ok) missingInputs.push('installation:INSTALLATION_RECORD_UNVERIFIED');
    }
    missingInputs.push('childPrincipal:ACTUAL_WORKER_OBSERVATION_REQUIRED');
  }
  return {
    status: missingInputs.length || os === 'unsupported' ? 'BLOCKED_CONTRACT'
      : fixture ? 'FIXTURE_ONLY' : 'READY_FOR_QUALIFICATION',
    evidenceOrigin: fixture ? 'synthetic-fixture' : 'installed-preflight',
    protectedHostContract: PROTECTED_HOST_CONTRACT, hostBoundary,
    currentOs: os, runtimePrincipal: principal,
    osExecution: { windows: os === 'windows' ? 'PREFLIGHT_EXECUTED' : 'SEPARATE_HOST_REQUIRED',
      linux: os === 'linux' ? 'PREFLIGHT_EXECUTED' : 'SEPARATE_HOST_REQUIRED' },
    checks, policy, missingInputs,
    qualification: { hostSupported: 'unknown', configured: 'unconfirmed', observed: false },
    remainingQualification: ['operator-measured installed VM build and AGS build',
      'actual worker service and child token/uid, protected-file and IPC denial probes',
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
