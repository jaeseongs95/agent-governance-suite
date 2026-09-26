import assert from 'node:assert/strict';
import { test } from 'vitest';
import { planWindowsIssuerInstall, planWindowsIssuerRollback, validateWindowsServiceDefinition } from '../../../runtime/issuer/windows/service/service-plan.mjs';

// B14-q-a4: plan-only FIXTURE. Nothing here registers a service, creates an account or changes an ACL.
// The real SCM token, cross-user and worker-descendant denials stay NOT_RUN (B14-q-b, B14-q-c gates).
const root = 'C:\\ProgramData\\agent-governance-suite';
const subtree = `${root}\\issuer`;
const issuerSid = 'S-1-5-80-1-2-3-4-5';
const receiverSid = 'S-1-5-80-6-7-8-9-10';
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
    caller: { accountKind: 'interactive-user', accountName: 'HOST\\user', observedSid: 'S-1-5-21-1-2-3-1001',
      groupPolicy: { forbiddenSids: [admins] }, privilegePolicy: { allowed: [] } },
    worker: { accountKind: 'interactive-user', accountName: 'HOST\\user', observedSid: 'S-1-5-21-1-2-3-1001',
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
const absent = { subtreeExists: () => false };
const edited = (edit) => { const r = validRecord(); edit(r); return r; };
const definition = (role) => planWindowsIssuerInstall(validRecord(), absent).services.find((d) => d.role === role);

test('B14-q-a4 plans virtual-account services with quoted protected binPaths and no execution', () => {
  const plan = planWindowsIssuerInstall(validRecord(), absent);
  assert.equal(plan.mode, 'plan');
  assert.equal(plan.installId, 'install-1');
  assert.deepEqual(plan.steps[0], { action: 'create-protected-subtree', path: subtree, owner: '*S-1-5-18', requireAbsent: true });
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

// Service definitions are checked on their own, for both services.
for (const role of ['issuer', 'receiver']) {
  const cases = {
    'LocalSystem account': (d) => { d.obj = 'LocalSystem'; },
    'NT AUTHORITY\\SYSTEM account': (d) => { d.obj = 'NT AUTHORITY\\SYSTEM'; },
    'LocalService account': (d) => { d.obj = 'NT AUTHORITY\\LocalService'; },
    'local administrator account': (d) => { d.obj = '.\\Administrator'; },
    'account of the other service': (d) => { d.obj = role === 'issuer' ? 'NT SERVICE\\ags-receiver' : 'NT SERVICE\\ags-issuer'; },
    'right name with the SYSTEM SID': (d) => { d.sid = 'S-1-5-18'; },
    'right name with a user SID': (d) => { d.sid = 'S-1-5-21-1-2-3-1001'; },
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

// Install inputs are refused before any step is planned, for both services.
for (const role of ['issuer', 'receiver']) {
  const cases = {
    'a LocalSystem principal': (r) => { r.principals[role].accountKind = 'local-system'; },
    'a SYSTEM account name': (r) => { r.principals[role].accountName = 'NT AUTHORITY\\SYSTEM'; },
    'a SYSTEM observed SID': (r) => { r.principals[role].observedSid = 'S-1-5-18'; },
    'a principal holding Administrators': (r) => { r.principals[role].groupPolicy.forbiddenSids = []; },
    'no account kind': (r) => { delete r.principals[role].accountKind; },
    'no observed SID': (r) => { delete r.principals[role].observedSid; },
    'an observed SID shared with the caller': (r) => { r.principals.caller.observedSid = r.principals[role].observedSid; },
    'an unprotected binary path': (r) => { r.services[role].binaryPath = 'C:\\Users\\user\\ags.exe'; },
    'a binary under mutable state': (r) => { r.services[role].binaryPath = `${subtree}\\state\\${r.services[role].serviceName}.exe`; },
  };
  for (const [label, edit] of Object.entries(cases)) {
    test(`B14-q-a4 install rejects ${role} with ${label}`, () => {
      assert.throws(() => planWindowsIssuerInstall(edited(edit), absent));
    });
  }
}

test('B14-q-a4 install rejects issuer and receiver sharing a service name or account', () => {
  const sameName = (r) => { r.services.receiver.serviceName = 'ags-issuer'; r.principals.receiver.accountName = 'NT SERVICE\\ags-issuer'; };
  const sameAccount = (r) => { r.principals.receiver.accountName = 'NT SERVICE\\ags-issuer'; };
  const sameSid = (r) => { r.principals.receiver.observedSid = issuerSid; };
  for (const edit of [sameName, sameAccount, sameSid]) assert.throws(() => planWindowsIssuerInstall(edited(edit), absent));
});

test('B14-q-a4 install refuses an existing or unobservable protected subtree', () => {
  const seen = [];
  assert.throws(() => planWindowsIssuerInstall(validRecord(), { subtreeExists: (path) => { seen.push(path); return true; } }));
  assert.deepEqual(seen, [subtree]);
  assert.throws(() => planWindowsIssuerInstall(validRecord(), { subtreeExists: (path) => path.toLowerCase() === subtree.toLowerCase() }));
  assert.throws(() => planWindowsIssuerInstall(validRecord(), { subtreeExists: () => { throw new Error('EACCES'); } }));
  assert.throws(() => planWindowsIssuerInstall(validRecord(), { subtreeExists: () => undefined }));
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
    assert.ok(after.some((step) => step.action === 'reassign-owner' && step.fromSid === `*${sid}` && step.toSid === '*S-1-5-18' && step.path === subtree && step.recursive));
    assert.ok(after.some((step) => step.action === 'remove-ace' && step.sid === `*${sid}` && step.path === subtree && step.recursive));
    assert.ok(after.some((step) => step.action === 'verify-no-residual-sid' && step.sid === `*${sid}` && step.path === subtree));
  }
  assert.ok(!JSON.stringify(after).includes('NT SERVICE'), 'post-delete steps must not resolve accounts by name');
  assert.ok(plan.steps.slice(0, lastDelete + 1).every((step) => step.tool === 'sc.exe'), 'no SID cleanup before the services are gone');
  assert.deepEqual(after.at(-1), { action: 'remove-protected-subtree', path: subtree });
  assert.throws(() => planWindowsIssuerRollback(edited((r) => { delete r.principals.issuer.observedSid; })));
  assert.throws(() => planWindowsIssuerRollback(edited((r) => { r.principals.receiver.observedSid = issuerSid; })));
});
