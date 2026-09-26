import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv2020, addFormats } from "../../../schema-validation.mjs";

// B14-q-a4: SCM service definitions and install/rollback plans for the Windows issuer and receiver.
// Plan only: nothing here runs sc.exe, creates an account or changes an ACL. The installer executes a
// reviewed plan under explicit approval (B14-q-b); the service token and access denials are observed there.
const schema = JSON.parse(readFileSync(new URL("../contract/install-record.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateRecordSchema = ajv.compile(schema);
const isProtectedPath = ajv.getSchema(`${schema.$id}#/$defs/protectedPath`);
const ROLES = ["issuer", "receiver"];
const PRIVILEGES = ["SeChangeNotifyPrivilege"];
const SERVICE_NAME = /^ags-[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
// Separation compares SID strings, so every SID must be canonical: no zero padding, 32-bit sub-authorities.
const CANONICAL_SID = /^S-1-(?:0|[1-9][0-9]{0,12})(?:-(?:0|[1-9][0-9]{0,9})){1,15}$/;
const isCanonicalSid = (sid) => CANONICAL_SID.test(sid) && sid.split("-").slice(3).every((part) => Number(part) <= 0xffffffff);

// The SID Windows derives for NT SERVICE\<name>: SHA-1 of the upper-case name in UTF-16LE, read as five
// little-endian uint32 values. A derived value binds name to SID; it is not an observed service token.
export function serviceSidOf(serviceName) {
  const hash = createHash("sha1").update(Buffer.from(serviceName.toUpperCase(), "utf16le")).digest();
  return `S-1-5-80-${[0, 4, 8, 12, 16].map((offset) => hash.readUInt32LE(offset)).join("-")}`;
}
const TRUSTED_OWNERS = ["S-1-5-18", "S-1-5-32-544", serviceSidOf("TrustedInstaller")];
// Non-admin rights are read, execute, write, append, delete, delete-child, write-dac and write-owner.
// Existing ancestors may let non-administrators add entries but never delete, rename or re-ACL them;
// an existing protectedRoot must not even let them add entries. Any other right is unknown and refuses.
const ANCESTOR_RIGHTS = ["read", "execute", "write", "append"];
const ROOT_RIGHTS = ["read", "execute"];
const PROTECTED_DACL = { protected: true, allow: [{ sid: "*S-1-5-18", access: "full" }, { sid: "*S-1-5-32-544", access: "full" }] };

export function validateWindowsServiceDefinition(definition) {
  const { serviceName, binPath, obj, sid, sidType, startType, requiredPrivileges } = definition;
  if (!SERVICE_NAME.test(serviceName)) throw new Error("Service names must be ags-<name>.");
  const executable = /^"([^"]+\.exe)"$/.exec(binPath)?.[1];
  if (!executable || !isProtectedPath(executable)) throw new Error("binPath must be one quoted executable inside the protected subtree.");
  // Name, SID, sidtype and privileges bind together; none of them qualifies the service alone.
  if (obj !== `NT SERVICE\\${serviceName}`) throw new Error("A service must run as its own virtual account.");
  if (sid !== serviceSidOf(serviceName)) throw new Error("A service SID must be the one derived from its service name.");
  if (sidType !== "restricted") throw new Error("A service SID type must be restricted.");
  if (!["demand", "auto"].includes(startType)) throw new Error("A service start type must be demand or auto.");
  if (JSON.stringify(requiredPrivileges) !== JSON.stringify(PRIVILEGES)) throw new Error("A service may hold only SeChangeNotifyPrivilege.");
  return definition;
}

function validateRecord(record) {
  if (!validateRecordSchema(record)) throw new Error(`Invalid install record: ${ajv.errorsText(validateRecordSchema.errors)}`);
  const { principals: p, services: s, paths } = record;
  if (!Object.values(p).every((principal) => isCanonicalSid(principal.observedSid))) throw new Error("Every principal SID must be canonical.");
  // Each service SID is derived from its name (checked in the definition), so distinct names mean distinct SIDs.
  if (s.issuer.serviceName === s.receiver.serviceName) throw new Error("Issuer and receiver services must differ.");
  const others = [p.installer.observedSid, p.caller.observedSid, p.worker.observedSid];
  for (const role of ROLES) {
    if (p[role].accountName !== `NT SERVICE\\${s[role].serviceName}`) throw new Error(`The ${role} account must be its own service's virtual account.`);
    if (others.includes(p[role].observedSid)) throw new Error(`The ${role} SID must differ from installer, caller and worker.`);
    if (s[role].binaryPath.toLowerCase().startsWith(`${paths.stateDirectory.toLowerCase()}\\`))
      throw new Error("Service binaries must stay outside mutable state.");
  }
  if (s.issuer.binaryPath.toLowerCase() === s.receiver.binaryPath.toLowerCase()) throw new Error("Issuer and receiver binaries must differ.");
  return record;
}

// observePath(path) is the installer's observation: { exists: false } or { exists: true, owner, reparse,
// nonAdminRights }. Anything else, or an error, is unknown and refuses the plan (P6.1).
function observe(observePath, path) {
  let seen;
  try { seen = observePath(path); } catch (error) { throw new Error(`${path} could not be observed.`, { cause: error }); }
  if (seen?.exists === false) return seen;
  if (seen?.exists !== true || typeof seen.reparse !== "boolean" || !Array.isArray(seen.nonAdminRights)) throw new Error(`${path} could not be observed.`);
  return seen;
}
function requireSafe(seen, path, allowedRights) {
  if (!seen.exists) throw new Error(`${path} must already exist.`);
  if (!TRUSTED_OWNERS.includes(seen.owner) || seen.reparse || !seen.nonAdminRights.every((right) => allowedRights.includes(right)))
    throw new Error(`${path} could be replaced or re-permissioned by a non-administrator.`);
}

const subtreeOf = (record) => `${record.paths.protectedRoot}\\issuer`;
const definitionsOf = (record) => ROLES.map((role) => validateWindowsServiceDefinition({
  role, serviceName: record.services[role].serviceName, binPath: `"${record.services[role].binaryPath}"`,
  obj: record.principals[role].accountName, sid: record.principals[role].observedSid, sidType: record.services[role].sidType,
  startType: record.services[role].startType, requiredPrivileges: PRIVILEGES }));

export function planWindowsIssuerInstall(record, { observePath } = {}) {
  validateRecord(record);
  // Definitions bind each service name to its derived SID before anything is observed.
  const services = definitionsOf(record);
  if (typeof observePath !== "function") throw new Error("The protected paths must be observed before planning.");
  const root = record.paths.protectedRoot;
  const subtree = subtreeOf(record);
  const ancestors = ["C:\\", "C:\\ProgramData"];
  for (const path of ancestors) requireSafe(observe(observePath, path), path, ANCESTOR_RIGHTS);
  const rootSeen = observe(observePath, root);
  if (rootSeen.exists) requireSafe(rootSeen, root, ROOT_RIGHTS);
  if (observe(observePath, subtree).exists) throw new Error("The protected subtree already exists.");
  const owner = `*${record.principals.installer.observedSid}`;
  return { mode: "plan", installId: record.installId, services, steps: [
    // The executor re-observes these under the same rules right before creating anything (B14-q-b).
    { action: "reverify-parents", paths: [...ancestors, root] },
    ...(rootSeen.exists ? [] : [{ action: "create-protected-directory", path: root, owner, requireAbsent: true, dacl: PROTECTED_DACL }]),
    { action: "create-protected-subtree", path: subtree, owner, requireAbsent: true, dacl: PROTECTED_DACL },
    ...services.flatMap((d) => [
      { tool: "sc.exe", args: ["create", d.serviceName, "binPath=", d.binPath, "obj=", d.obj, "type=", "own", "start=", d.startType] },
      { tool: "sc.exe", args: ["sidtype", d.serviceName, d.sidType] },
      { tool: "sc.exe", args: ["privs", d.serviceName, d.requiredPrivileges.join("/")] },
      { action: "verify-service-sid", serviceName: d.serviceName, expectedSid: d.sid },
    ]),
  ] };
}

// Once a service is deleted its virtual account no longer resolves by name, so cleanup names the raw SID (D2 condition 2).
export function planWindowsIssuerRollback(record) {
  validateRecord(record);
  const subtree = subtreeOf(record);
  const owner = `*${record.principals.installer.observedSid}`;
  const services = definitionsOf(record);
  return { mode: "plan", installId: record.installId, steps: [
    ...services.map((d) => ({ tool: "sc.exe", args: ["stop", d.serviceName] })),
    ...services.map((d) => ({ tool: "sc.exe", args: ["delete", d.serviceName] })),
    ...services.flatMap((d) => [
      { action: "reassign-owner", path: subtree, fromSid: `*${d.sid}`, toSid: owner, recursive: true },
      { action: "remove-ace", path: subtree, sid: `*${d.sid}`, recursive: true },
      { action: "verify-no-residual-sid", path: subtree, sid: `*${d.sid}` },
    ]),
    { action: "remove-protected-subtree", path: subtree },
  ] };
}
