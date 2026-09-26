import assert from 'node:assert/strict';
import { test } from 'vitest';
import { planWindowsIssuerInstall, planWindowsIssuerRollback, serviceSidOf, validateWindowsServiceDefinition } from '../../../runtime/issuer/windows/service/service-plan.mjs';

// B14-q-a4: plan-only FIXTURE. Nothing here registers a service, creates an account or changes an ACL.
// The real SCM token, cross-user and worker-descendant denials stay NOT_RUN (B14-q-b, B14-q-c gates).
// Service SIDs below are the values Windows derives from the names (cross-checked read-only with
// `sc.exe showsid`); a derived value is not an observation of the running service token.
const root = 'C:\\ProgramData\\agent-governance-suite';
const subtree = `${root}\\issuer`;
const issuerSid = 'S-1-5-80-2374351460-1261223942-2447500557-4136121489-593351303';
const receiverSid = 'S-1-5-80-3088520731-3733327115-806648351-2150893619-3077959104';
const trustedInstallerSid = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
const userSid = 'S-1-5-21-1-2-3-1001';
const digest = (c) => `sha256:${c.repeat(64)}`;
const admins = 'S-1-5-32-544';
const service = (name, sid) => ({ accountKind: 'virtual-service-account', accountName: `NT SERVICE\\${name}`,
  observedSid: sid, groupPolicy: { forbiddenSids: [admins] }, privilegePolicy: { allowed: ['SeChangeNotifyPrivilege'] } });
const validRecord = () => ({
  contractId: 'ags-windows-issuer-install/v1', revision: 1, os: 'windows', installId: 'install-1',
  contractDigests: { provisioning: digest('a'), nativePrincipalIssuer: digest('b'), nativePrincipalIssuerFixture: digest('c') },
  principals: {
    installer: { accountKind: 'local-system', accountName: 'NT AUTHORITY\\SYSTEM', observedSid: 'S-1-5-18',
      groupPolicy: { forbiddenSids: [] }, privilegePolicy: { allowed: [] } },
    issuer: service('ags-issuer', issuerSid),
    receiver: service('ags-receiver', receiverSid),
    caller: { accountKind: 'interactive-user', accountName: 'HOST\\user', observedSid: userSid,
      groupPolicy: { forbiddenSids: [admins] }, privilegePolicy: { allowed: [] } },
    worker: { accountKind: 'interactive-user', accountName: 'HOST\\user', observedSid: userSid,
      groupPolicy: { forbiddenSids: [admins] }, privilegePolicy: { allowed: [] } },
  },
  services: {
    issuer: { serviceName: 'ags-issuer', sidType: 'restricted', startType: 'auto', binaryPath: `${subtree}\\bin\\ags-issuer.exe` },
    receiver: { serviceName: 'ags-receiver', sidType: 'restricted', startType: 'auto', binaryPath: `${subtree}\\bin\\ags-receiver.exe` },
  },
  paths: { protectedRoot: root, installRecord: `${subtree}\\install-record.json`,
    registry: `${subtree}\\state\\registry.json`, stateDirectory: `${subtree}\\state` },
  endpoint: { pipeName: '\\\\.\\pipe\\ags-issuer-1' },
  build: { buildDigest: digest('d'), closureDigest: digest('e') },
});
// The installer's observation of each path from the volume root down to the subtree. Stock Windows lets
// non-administrators add entries to C:\ and C:\ProgramData, but not delete, rename or re-ACL them.
const safeAncestor = (owner) => ({ exists: true, owner, reparse: false, nonAdminRights: ['read', 'execute', 'write', 'append'] });
const stock = () => ({ 'C:\\': safeAncestor(trustedInstallerSid), 'C:\\ProgramData': safeAncestor('S-1-5-18'),
  [root]: { exists: false }, [subtree]: { exists: false } });
const observer = (overrides = {}, seen = []) => {
  const world = { ...stock(), ...overrides };
  return { observePath: (path) => { seen.push(path); if (!(path in world)) throw new Error(`unexpected ${path}`); return structuredClone(world[path]); } };
};
const edited = (edit) => { const r = validRecord(); edit(r); return r; };
const definition = (role) => planWindowsIssuerInstall(validRecord(), observer()).services.find((d) => d.role === role);
// Created directories and rollback ownership go to Administrators, never to the installing user's SID.
const adminsOwner = '*S-1-5-32-544';
const protectedDacl = { protected: true, allow: [{ sid: '*S-1-5-18', access: 'full' }, { sid: '*S-1-5-32-544', access: 'full' }] };

test('B14-q-a4 plans virtual-account services with quoted protected binPaths and no execution', () => {
  const seen = [];
  const plan = planWindowsIssuerInstall(validRecord(), observer({}, seen));
  assert.deepEqual(seen, ['C:\\', 'C:\\ProgramData', root, subtree]);
  assert.equal(plan.mode, 'plan');
  assert.equal(plan.installId, 'install-1');
  // Execution must re-observe the parents under the same rules before creating anything (B14-q-b duty).
  assert.deepEqual(plan.steps[0], { action: 'reverify-parents', paths: ['C:\\', 'C:\\ProgramData', root] });
  assert.deepEqual(plan.steps[1], { action: 'create-protected-directory', path: root, owner: adminsOwner, requireAbsent: true, dacl: protectedDacl });
  assert.deepEqual(plan.steps[2], { action: 'create-protected-subtree', path: subtree, owner: adminsOwner, requireAbsent: true, dacl: protectedDacl });
  for (const [role, name, sid] of [['issuer', 'ags-issuer', issuerSid], ['receiver', 'ags-receiver', receiverSid]]) {
    const exe = `${subtree}\\bin\\${name}.exe`;
    assert.deepEqual(definition(role), { role, serviceName: name, binPath: `"${exe}"`, obj: `NT SERVICE\\${name}`, sid,
      sidType: 'restricted', startType: 'auto', requiredPrivileges: ['SeChangeNotifyPrivilege'] });
    const steps = plan.steps.filter((step) => step.args?.[1] === name);
    assert.deepEqual(steps.map((step) => [step.tool, ...step.args]), [
      ['sc.exe', 'create', name, 'binPath=', `"${exe}"`, 'obj=', `NT SERVICE\\${name}`, 'type=', 'own', 'start=', 'auto'],
      ['sc.exe', 'sidtype', name, 'restricted'],
      ['sc.exe', 'privs', name, 'SeChangeNotifyPrivilege'],
    ]);
    // Name and sidtype alone never qualify: the service SID must be observed and match the record.
    assert.ok(plan.steps.some((step) => step.action === 'verify-service-sid' && step.serviceName === name && step.expectedSid === sid));
  }
  assert.ok(plan.steps.findIndex((step) => step.action === 'create-protected-subtree') < plan.steps.findIndex((step) => step.tool === 'sc.exe'));
  assert.ok(!JSON.stringify(plan).includes('password='), 'virtual accounts take no password');
});

test('B14-q-a4 an existing protectedRoot is kept only when it is already safe', () => {
  const safeRoot = { exists: true, owner: 'S-1-5-32-544', reparse: false, nonAdminRights: ['read', 'execute'] };
  const plan = planWindowsIssuerInstall(validRecord(), observer({ [root]: safeRoot }));
  assert.ok(!plan.steps.some((step) => step.action === 'create-protected-directory'));
  assert.deepEqual(plan.steps[1], { action: 'create-protected-subtree', path: subtree, owner: adminsOwner, requireAbsent: true, dacl: protectedDacl });
});

// Service definitions are checked on their own, for both services.
for (const role of ['issuer', 'receiver']) {
  const cases = {
    'LocalSystem account': (d) => { d.obj = 'LocalSystem'; },
    'NT AUTHORITY\\SYSTEM account': (d) => { d.obj = 'NT AUTHORITY\\SYSTEM'; },
    'LocalService account': (d) => { d.obj = 'NT AUTHORITY\\LocalService'; },
    'local administrator account': (d) => { d.obj = '.\\Administrator'; },
    'account of the other service': (d) => { d.obj = role === 'issuer' ? 'NT SERVICE\\ags-receiver' : 'NT SERVICE\\ags-issuer'; },
    'right name with the SYSTEM SID': (d) => { d.sid = 'S-1-5-18'; },
    'right name with a user SID': (d) => { d.sid = userSid; },
    'right name with an arbitrary service-shaped SID': (d) => { d.sid = 'S-1-5-80-1-2-3-4-5'; },
    'right name with the other service SID': (d) => { d.sid = role === 'issuer' ? receiverSid : issuerSid; },
    'right name with the TrustedInstaller SID': (d) => { d.sid = trustedInstallerSid; },
    'its own SID zero-padded': (d) => { d.sid = d.sid.replace(/-(\d+)$/, '-0$1'); },
    'a sub-authority past 32 bits': (d) => { d.sid = d.sid.replace(/-(\d+)$/, '-4294967296'); },
    // Name, account and SID agree here, so only the ags- name rule can refuse it.
    'a consistent name outside ags-': (d) => { d.serviceName = 'svc'; d.obj = 'NT SERVICE\\svc'; d.sid = serviceSidOf('svc'); },
    'a boot start type': (d) => { d.startType = 'boot'; },
    'unrestricted sidtype': (d) => { d.sidType = 'unrestricted'; },
    'extra privilege': (d) => { d.requiredPrivileges = ['SeChangeNotifyPrivilege', 'SeDebugPrivilege']; },
    'unquoted binPath': (d) => { d.binPath = d.binPath.slice(1, -1); },
    'quoted binPath with trailing arguments': (d) => { d.binPath = `${d.binPath} --debug`; },
    'quoted binPath outside the protected subtree': (d) => { d.binPath = '"C:\\Users\\user\\ags-issuer.exe"'; },
    'quoted binPath through a parent segment': (d) => { d.binPath = `"${subtree}\\..\\..\\Temp\\ags.exe"`; },
  };
  for (const [label, edit] of Object.entries(cases)) {
    test(`B14-q-a4 ${role} definition rejects ${label}`, () => {
      const valid = definition(role);
      assert.doesNotThrow(() => validateWindowsServiceDefinition(valid));
      const broken = structuredClone(valid);
      edit(broken);
      assert.throws(() => validateWindowsServiceDefinition(broken));
    });
  }
}

// Install and rollback inputs are refused before any step is planned, for both services.
for (const role of ['issuer', 'receiver']) {
  const other = role === 'issuer' ? 'receiver' : 'issuer';
  const cases = {
    'a LocalSystem principal': (r) => { r.principals[role].accountKind = 'local-system'; },
    'a SYSTEM account name': (r) => { r.principals[role].accountName = 'NT AUTHORITY\\SYSTEM'; },
    'a SYSTEM observed SID': (r) => { r.principals[role].observedSid = 'S-1-5-18'; },
    'a principal holding Administrators': (r) => { r.principals[role].groupPolicy.forbiddenSids = []; },
    'no account kind': (r) => { delete r.principals[role].accountKind; },
    'no observed SID': (r) => { delete r.principals[role].observedSid; },
    'an arbitrary service-shaped SID': (r) => { r.principals[role].observedSid = 'S-1-5-80-1-2-3-4-5'; },
    'the TrustedInstaller SID': (r) => { r.principals[role].observedSid = trustedInstallerSid; },
    'an observed SID shared with the caller': (r) => { r.principals.caller.observedSid = r.principals[role].observedSid; },
    'an observed SID shared with the worker': (r) => { r.principals.worker.observedSid = r.principals[role].observedSid; },
    'an observed SID shared with an administrator installer': (r) => {
      Object.assign(r.principals.installer, { accountKind: 'administrator', observedSid: r.principals[role].observedSid }); },
    'a worker holding its SID zero-padded': (r) => { r.principals.worker.observedSid = r.principals[role].observedSid.replace(/-(\d+)$/, '-0$1'); },
    'an unprotected binary path': (r) => { r.services[role].binaryPath = 'C:\\Users\\user\\ags.exe'; },
    'a binary under mutable state': (r) => { r.services[role].binaryPath = `${subtree}\\state\\${r.services[role].serviceName}.exe`; },
    'a binary under mutable state in other case': (r) => { r.services[role].binaryPath = `${subtree}\\STATE\\${r.services[role].serviceName}.exe`; },
    'the other service binary': (r) => { r.services[role].binaryPath = r.services[other].binaryPath; },
    'the other service binary in other case': (r) => { r.services[role].binaryPath = r.services[other].binaryPath.replace('\\bin\\', '\\BIN\\'); },
  };
  for (const [label, edit] of Object.entries(cases)) {
    test(`B14-q-a4 install and rollback reject ${role} with ${label}`, () => {
      assert.throws(() => planWindowsIssuerInstall(edited(edit), observer()));
      assert.throws(() => planWindowsIssuerRollback(edited(edit)));
    });
  }
}

test('B14-q-a4 install and rollback reject shared or non-canonical principal identities', () => {
  const sameName = (r) => { r.services.receiver.serviceName = 'ags-issuer'; r.principals.receiver.accountName = 'NT SERVICE\\ags-issuer'; r.principals.receiver.observedSid = issuerSid; };
  const sameAccount = (r) => { r.principals.receiver.accountName = 'NT SERVICE\\ags-issuer'; };
  const sameSid = (r) => { r.principals.receiver.observedSid = issuerSid; };
  const swapped = (r) => { r.principals.issuer.observedSid = receiverSid; r.principals.receiver.observedSid = issuerSid; };
  // Separation compares SID strings, so every principal SID must be canonical and within 32-bit sub-authorities.
  const paddedInstaller = (r) => { Object.assign(r.principals.installer, { accountKind: 'administrator', observedSid: 'S-1-5-21-01-2-3-500' }); };
  const wideCaller = (r) => { r.principals.caller.observedSid = 'S-1-5-21-1-2-3-4294967296'; };
  for (const edit of [sameName, sameAccount, sameSid, swapped, paddedInstaller, wideCaller]) {
    assert.throws(() => planWindowsIssuerInstall(edited(edit), observer()));
    assert.throws(() => planWindowsIssuerRollback(edited(edit)));
  }
});

test('B14-q-a4 install refuses a pre-existing, unsafe or unobservable path from the volume root down', () => {
  const unsafe = (owner, extra = {}) => ({ exists: true, owner, reparse: false, nonAdminRights: ['read', 'execute'], ...extra });
  const refused = {
    'existing subtree': { [root]: unsafe('S-1-5-18'), [subtree]: unsafe('S-1-5-18') },
    'subtree reported without its root': { [subtree]: unsafe('S-1-5-18') },
    'user-owned protectedRoot': { [root]: unsafe(userSid) },
    'protectedRoot as a junction': { [root]: unsafe('S-1-5-18', { reparse: true }) },
    ...Object.fromEntries(['write', 'append', 'delete', 'delete-child', 'write-dac', 'write-owner'].map((right) =>
      [`protectedRoot with non-admin ${right}`, { [root]: unsafe('S-1-5-18', { nonAdminRights: ['read', right] }) }])),
    ...Object.fromEntries(['delete', 'delete-child', 'write-dac', 'write-owner'].map((right) =>
      [`ProgramData with non-admin ${right}`, { 'C:\\ProgramData': { ...safeAncestor('S-1-5-18'), nonAdminRights: ['write', right] } }])),
    'ProgramData as a junction': { 'C:\\ProgramData': { ...safeAncestor('S-1-5-18'), reparse: true } },
    'user-owned ProgramData': { 'C:\\ProgramData': safeAncestor(userSid) },
    'absent ProgramData': { 'C:\\ProgramData': { exists: false } },
    'user-owned volume root': { 'C:\\': safeAncestor(userSid) },
    'unknown non-admin right': { [root]: unsafe('S-1-5-18', { nonAdminRights: ['read', 'special'] }) },
    'existing path without owner': { [root]: { exists: true, reparse: false, nonAdminRights: [] } },
    'existing path without reparse answer': { [root]: { exists: true, owner: 'S-1-5-18', nonAdminRights: [] } },
    'existing path without rights answer': { [root]: { exists: true, owner: 'S-1-5-18', reparse: false } },
    'existence not a boolean': { [root]: { exists: 'no' } },
    'observation not an object': { [subtree]: undefined },
  };
  for (const [label, overrides] of Object.entries(refused)) {
    assert.throws(() => planWindowsIssuerInstall(validRecord(), observer(overrides)), undefined, label);
  }
  assert.throws(() => planWindowsIssuerInstall(validRecord(), { observePath: (path) => { if (path === root) throw new Error('EACCES'); return stock()[path]; } }));
  assert.throws(() => planWindowsIssuerInstall(validRecord(), {}));
  assert.throws(() => planWindowsIssuerInstall(validRecord()));
});

test('B14-q-a4 rollback deletes both services, then clears what their SIDs still own by SID', () => {
  const plan = planWindowsIssuerRollback(validRecord());
  assert.equal(plan.mode, 'plan');
  const sc = plan.steps.filter((step) => step.tool === 'sc.exe').map((step) => step.args);
  assert.deepEqual(sc, [['stop', 'ags-issuer'], ['stop', 'ags-receiver'], ['delete', 'ags-issuer'], ['delete', 'ags-receiver']]);
  const lastDelete = plan.steps.findLastIndex((step) => step.args?.[0] === 'delete');
  const after = plan.steps.slice(lastDelete + 1);
  for (const sid of [issuerSid, receiverSid]) {
    // After deletion the virtual account name no longer resolves, so every later step names the raw SID.
    assert.ok(after.some((step) => step.action === 'reassign-owner' && step.fromSid === `*${sid}` && step.toSid === adminsOwner && step.path === subtree && step.recursive));
    assert.ok(after.some((step) => step.action === 'remove-ace' && step.sid === `*${sid}` && step.path === subtree && step.recursive));
    assert.ok(after.some((step) => step.action === 'verify-no-residual-sid' && step.sid === `*${sid}` && step.path === subtree));
  }
  assert.ok(!JSON.stringify(after).includes('NT SERVICE'), 'post-delete steps must not resolve accounts by name');
  assert.ok(plan.steps.slice(0, lastDelete + 1).every((step) => step.tool === 'sc.exe'), 'no SID cleanup before the services are gone');
  assert.deepEqual(after.at(-1), { action: 'remove-protected-subtree', path: subtree });
});

test('B14-q-a4 a same-user administrator install still hands ownership to Administrators', () => {
  // UAC same-user install: installer, caller and worker share one user SID; the record keeps that real SID.
  const sameUser = edited((r) => { Object.assign(r.principals.installer, { accountKind: 'administrator', accountName: 'HOST\\user', observedSid: userSid }); });
  const install = planWindowsIssuerInstall(sameUser, observer());
  const created = install.steps.filter((step) => step.action?.startsWith('create-protected-'));
  assert.deepEqual(created.map((step) => [step.action, step.owner]), [['create-protected-directory', adminsOwner], ['create-protected-subtree', adminsOwner]]);
  const rollback = planWindowsIssuerRollback(sameUser);
  const reassigned = rollback.steps.filter((step) => step.action === 'reassign-owner');
  assert.deepEqual(reassigned.map((step) => [step.fromSid, step.toSid]), [[`*${issuerSid}`, adminsOwner], [`*${receiverSid}`, adminsOwner]]);
  assert.ok(!JSON.stringify([install.steps, rollback.steps]).includes(userSid), 'the installing user never becomes an owner');
});

test('B14-q-a4 replanning after a rollback keeps an Administrators-owned root and refuses anything else', () => {
  // Rollback removes the subtree and leaves the root it created; a new install accepts that root as is.
  const kept = { exists: true, owner: 'S-1-5-32-544', reparse: false, nonAdminRights: ['read', 'execute'] };
  const plan = planWindowsIssuerInstall(validRecord(), observer({ [root]: kept }));
  assert.ok(!plan.steps.some((step) => step.action === 'create-protected-directory'));
  assert.equal(plan.steps.find((step) => step.action === 'create-protected-subtree').owner, adminsOwner);
  assert.throws(() => planWindowsIssuerInstall(validRecord(), observer({ [root]: { ...kept, owner: userSid } })));
  assert.throws(() => planWindowsIssuerInstall(validRecord(), observer({ [root]: kept, [subtree]: kept })));
});

test('B14-q-a4 the 32-bit bound applies to the first sub-authority too', () => {
  const withUser = (sid) => edited((r) => { r.principals.caller.observedSid = sid; r.principals.worker.observedSid = sid; });
  assert.doesNotThrow(() => planWindowsIssuerInstall(withUser('S-1-5-4294967295-2-3-1001'), observer()));
  assert.doesNotThrow(() => planWindowsIssuerRollback(withUser('S-1-5-4294967295-2-3-1001')));
  assert.throws(() => planWindowsIssuerInstall(withUser('S-1-5-4294967296-2-3-1001'), observer()));
  assert.throws(() => planWindowsIssuerRollback(withUser('S-1-5-4294967296-2-3-1001')));
});
