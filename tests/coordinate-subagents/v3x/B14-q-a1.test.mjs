import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

// B14-q-a1: schema-only contract. Passing it is FIXTURE evidence, never an observed install.
const load = async (name) => JSON.parse(await readFile(new URL(`../../../runtime/issuer/windows/contract/${name}`, import.meta.url), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const record = ajv.compile(await load('install-record.schema.json'));
const frameSchema = await load('ipc-frame.schema.json');
ajv.addSchema(frameSchema);
const frame = ajv.compile(frameSchema);
const request = ajv.getSchema(`${frameSchema.$id}#/$defs/request`);
const response = ajv.getSchema(`${frameSchema.$id}#/$defs/response`);

const digest = (c) => `sha256:${c.repeat(64)}`;
const nonce = (c) => c.repeat(32);
const root = 'C:\\ProgramData\\agent-governance-suite';
const admins = 'S-1-5-32-544';
const service = (name, sid) => ({ accountKind: 'virtual-service-account', accountName: `NT SERVICE\\${name}`,
  observedSid: sid, groupPolicy: { forbiddenSids: [admins] }, privilegePolicy: { allowed: ['SeChangeNotifyPrivilege'] } });
const validRecord = () => ({
  contractId: 'ags-windows-issuer-install/v1', revision: 1, os: 'windows', installId: 'install-1',
  contractDigests: { provisioning: digest('a'), nativePrincipalIssuer: digest('b'), nativePrincipalIssuerFixture: digest('c') },
  principals: {
    installer: { accountKind: 'local-system', accountName: 'NT AUTHORITY\\SYSTEM', observedSid: 'S-1-5-18',
      groupPolicy: { forbiddenSids: [] }, privilegePolicy: { allowed: [] } },
    issuer: service('ags-issuer', 'S-1-5-80-1-2-3-4-5'),
    receiver: service('ags-receiver', 'S-1-5-80-6-7-8-9-10'),
    caller: { accountKind: 'interactive-user', accountName: 'HOST\\user', observedSid: 'S-1-5-21-1-2-3-1001',
      groupPolicy: { forbiddenSids: [admins] }, privilegePolicy: { allowed: ['SeChangeNotifyPrivilege'] } },
    worker: { accountKind: 'interactive-user', accountName: 'HOST\\user', observedSid: 'S-1-5-21-1-2-3-1001',
      groupPolicy: { forbiddenSids: [admins] }, privilegePolicy: { allowed: [] } },
  },
  services: {
    issuer: { serviceName: 'ags-issuer', sidType: 'restricted', startType: 'auto', binaryPath: `${root}\\issuer\\bin\\ags-issuer.exe` },
    receiver: { serviceName: 'ags-receiver', sidType: 'restricted', startType: 'auto', binaryPath: `${root}\\issuer\\bin\\ags-receiver.exe` },
  },
  paths: { protectedRoot: root, installRecord: `${root}\\issuer\\install-record.json`,
    registry: `${root}\\issuer\\state\\registry.json`, stateDirectory: `${root}\\issuer\\state` },
  endpoint: { pipeName: '\\\\.\\pipe\\ags-issuer-1' },
  build: { buildDigest: digest('d'), closureDigest: digest('e') },
});
const mutate = (base, edit) => { const copy = structuredClone(base); edit(copy); return copy; };
const omit = (value, key) => { const copy = { ...value }; delete copy[key]; return copy; };
const rejects = (validate, value, label) => assert.equal(validate(value), false, `${label} must be invalid`);

test('B14-q-a1 install record accepts only the complete P3.2 shape', () => {
  assert.equal(record(validRecord()), true, JSON.stringify(record.errors));
  // Every P3.2 field is required: dropping any one fails.
  const required = [
    ['contractId'], ['revision'], ['os'], ['installId'], ['contractDigests'], ['principals'], ['services'], ['paths'], ['endpoint'], ['build'],
    ['contractDigests', 'provisioning'], ['contractDigests', 'nativePrincipalIssuer'], ['contractDigests', 'nativePrincipalIssuerFixture'],
    ...['installer', 'issuer', 'receiver', 'caller', 'worker'].flatMap((role) => [['principals', role],
      ...['accountKind', 'accountName', 'observedSid', 'groupPolicy', 'privilegePolicy'].map((field) => ['principals', role, field])]),
    ...['issuer', 'receiver'].flatMap((name) => [['services', name],
      ...['serviceName', 'sidType', 'startType', 'binaryPath'].map((field) => ['services', name, field])]),
    ['paths', 'protectedRoot'], ['paths', 'installRecord'], ['paths', 'registry'], ['paths', 'stateDirectory'],
    ['endpoint', 'pipeName'], ['build', 'buildDigest'], ['build', 'closureDigest'],
  ];
  for (const path of required) {
    rejects(record, mutate(validRecord(), (copy) => { const leaf = path.at(-1); delete path.slice(0, -1).reduce((node, key) => node[key], copy)[leaf]; }), path.join('.'));
  }
  rejects(record, { ...validRecord(), note: 'extra' }, 'unknown top-level field');
});

test('B14-q-a1 install record rejects weakened principals, services, paths and endpoints', () => {
  const cases = {
    'LocalSystem issuer': (r) => { r.principals.issuer.accountKind = 'local-system'; },
    'local user issuer (D2 virtual account)': (r) => { r.principals.issuer.accountKind = 'local-user'; },
    'issuer name outside NT SERVICE': (r) => { r.principals.issuer.accountName = 'HOST\\ags-issuer'; },
    'issuer SID not a service SID': (r) => { r.principals.issuer.observedSid = 'S-1-5-21-1-2-3-1001'; },
    'extra issuer privilege': (r) => { r.principals.issuer.privilegePolicy.allowed.push('SeDebugPrivilege'); },
    'other issuer privilege': (r) => { r.principals.receiver.privilegePolicy.allowed = ['SeImpersonatePrivilege']; },
    'receiver may hold Administrators': (r) => { r.principals.receiver.groupPolicy.forbiddenSids = []; },
    'worker may hold Administrators': (r) => { r.principals.worker.groupPolicy.forbiddenSids = []; },
    'caller may hold Administrators': (r) => { r.principals.caller.groupPolicy.forbiddenSids = ['S-1-1-0']; },
    'caller running as LocalSystem': (r) => { r.principals.caller.accountKind = 'local-system'; },
    'installer as an interactive user': (r) => { r.principals.installer.accountKind = 'interactive-user'; },
    'installer SID not a SID': (r) => { r.principals.installer.observedSid = 'UNKNOWN'; },
    'caller SID empty': (r) => { r.principals.caller.observedSid = ''; },
    'worker SID malformed': (r) => { r.principals.worker.observedSid = 'S-1-5-21-x'; },
    'forbidden group not a SID': (r) => { r.principals.worker.groupPolicy.forbiddenSids = [admins, 'Administrators']; },
    'service SID type unrestricted': (r) => { r.services.issuer.sidType = 'unrestricted'; },
    'binary outside protected subtree': (r) => { r.services.issuer.binaryPath = 'C:\\Users\\user\\ags-issuer.exe'; },
    'binary through parent segment': (r) => { r.services.issuer.binaryPath = `${root}\\issuer\\..\\..\\Temp\\ags-issuer.exe`; },
    'binary with trailing dot alias': (r) => { r.services.receiver.binaryPath = `${root}\\issuer\\bin.\\ags-receiver.exe`; },
    'binary via cmd wrapper': (r) => { r.services.issuer.binaryPath = `${root}\\issuer\\bin\\ags-issuer.cmd`; },
    'binary with alternate data stream': (r) => { r.services.issuer.binaryPath = `${root}\\issuer\\bin\\ags-issuer.exe:x.exe`; },
    'binary via 8.3 short name': (r) => { r.services.issuer.binaryPath = `${root}\\issuer\\BIN~1\\ags-issuer.exe`; },
    'registry on UNC path': (r) => { r.paths.registry = '\\\\server\\share\\registry.json'; },
    'state directory with forward slashes': (r) => { r.paths.stateDirectory = 'C:/ProgramData/agent-governance-suite/issuer/state'; },
    'caller-chosen install record path': (r) => { r.paths.installRecord = `${root}\\issuer\\other.json`; },
    'protected root moved': (r) => { r.paths.protectedRoot = 'C:\\ags'; },
    'pipe outside ags-issuer namespace': (r) => { r.endpoint.pipeName = '\\\\.\\pipe\\broker'; },
    'remote pipe host': (r) => { r.endpoint.pipeName = '\\\\server\\pipe\\ags-issuer-1'; },
    'pipe name with path suffix': (r) => { r.endpoint.pipeName = '\\\\.\\pipe\\ags-issuer-1\\x'; },
    'build digest wrong format': (r) => { r.build.buildDigest = 'a'.repeat(64); },
    'linux record': (r) => { r.os = 'linux'; },
  };
  for (const [label, edit] of Object.entries(cases)) rejects(record, mutate(validRecord(), edit), label);
});

test('B14-q-a1 request frames carry no caller-chosen endpoint, path, secret or identity', () => {
  const epochRequest = { schemaVersion: '1.0.0', kind: 'issuer-request', requestId: nonce('1'), epoch: null, operation: 'epoch' };
  const issueRequest = { schemaVersion: '1.0.0', kind: 'issuer-request', requestId: nonce('2'), epoch: nonce('e'),
    operation: 'issue', audience: 'peer-receiver/v1', receiverInstance: 'receiver-1' };
  assert.equal(request(epochRequest), true, JSON.stringify(request.errors));
  assert.equal(request(issueRequest), true, JSON.stringify(request.errors));
  assert.equal(frame(issueRequest), true);
  for (const field of ['pipeName', 'endpoint', 'path', 'installRecord', 'secret', 'token', 'brokerToken', 'expectedSid', 'callerSid', 'role']) {
    rejects(request, { ...issueRequest, [field]: 'x' }, `request.${field}`);
    rejects(frame, { ...issueRequest, [field]: 'x' }, `frame.${field}`);
  }
  rejects(request, { ...issueRequest, audience: 'resource-owner/v1' }, 'unknown audience');
  rejects(request, { ...issueRequest, epoch: null }, 'issue without epoch');
  rejects(request, { ...issueRequest, audience: undefined }, 'issue without audience');
  rejects(request, { ...epochRequest, epoch: nonce('e') }, 'epoch request claiming an epoch');
  rejects(request, { ...epochRequest, audience: 'peer-receiver/v1' }, 'epoch request with audience');
  rejects(request, { ...issueRequest, requestId: 'request-1' }, 'non-random request id');
  // Omission is not a default: every bound field must be present.
  for (const key of ['schemaVersion', 'kind', 'requestId', 'epoch', 'operation', 'audience', 'receiverInstance']) {
    rejects(request, omit(issueRequest, key), `issue request without ${key}`);
  }
  rejects(request, omit(epochRequest, 'epoch'), 'epoch request without epoch');
});

test('B14-q-a1 response frames have no unknown or implicit-success status', () => {
  const credential = { credentialId: 'cred-1', audience: 'peer-receiver/v1', receiverInstance: 'receiver-1',
    expiresAt: '2026-09-26T12:00:00.000Z', secret: 'A'.repeat(43) };
  const ok = { schemaVersion: '1.0.0', kind: 'issuer-response', requestId: nonce('2'), operation: 'issue', epoch: nonce('e'), status: 'ok', credential };
  const denied = { schemaVersion: '1.0.0', kind: 'issuer-response', requestId: nonce('2'), operation: 'issue', epoch: nonce('e'),
    status: 'rejected', error: { code: 'peer-identity-rejected' } };
  assert.equal(response(ok), true, JSON.stringify(response.errors));
  assert.equal(response(denied), true, JSON.stringify(response.errors));
  assert.equal(response({ ...ok, operation: 'epoch', credential: undefined }), true);
  for (const status of ['unknown', 'UNKNOWN', 'pass', 'partial', 'ok-unverified']) {
    rejects(response, { ...ok, status }, `status ${status} with credential`);
    rejects(response, { ...denied, status }, `status ${status} with error`);
  }
  rejects(response, { ...denied, credential }, 'rejection carrying a credential');
  rejects(response, { ...ok, error: { code: 'replay' } }, 'ok carrying an error');
  rejects(response, { ...ok, credential: undefined }, 'issue ok without credential');
  rejects(response, { ...ok, operation: 'epoch' }, 'epoch response carrying a credential');
  rejects(response, { ...denied, error: undefined }, 'rejection without error code');
  rejects(response, { ...denied, error: { code: 'something-else' } }, 'unknown error code');
  rejects(response, { ...ok, credential: { ...credential, audience: 'any' } }, 'credential audience outside the contract');
  rejects(response, { ...ok, credential: { ...credential, secret: 'short' } }, 'weak credential secret');
  rejects(response, { ...ok, epoch: null }, 'response without epoch');
  // A reply missing its status, epoch or binding fields is never an implicit success.
  for (const key of ['schemaVersion', 'kind', 'requestId', 'operation', 'epoch', 'status']) {
    rejects(response, omit(ok, key), `ok response without ${key}`);
  }
  rejects(response, { ...ok, trusted: true }, 'ok response with an extra field');
  rejects(response, { ...denied, retryAfter: 1 }, 'refusal with an extra field');
});
