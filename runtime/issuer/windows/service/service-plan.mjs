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
// Canonical service SID only: a zero-padded sub-authority would slip past string comparison.
const SERVICE_SID = /^S-1-5-80(?:-(?:0|[1-9][0-9]{0,9})){5}$/;
const SERVICE_NAME = /^ags-[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function validateWindowsServiceDefinition(definition) {
  const { serviceName, binPath, obj, sid, sidType, startType, requiredPrivileges } = definition;
  if (!SERVICE_NAME.test(serviceName)) throw new Error("Service names must be ags-<name>.");
  const executable = /^"([^"]+\.exe)"$/.exec(binPath)?.[1];
  if (!executable || !isProtectedPath(executable)) throw new Error("binPath must be one quoted executable inside the protected subtree.");
  // Name, SID, sidtype and privileges bind together; none of them qualifies the service alone.
  if (obj !== `NT SERVICE\\${serviceName}`) throw new Error("A service must run as its own virtual account.");
  if (!SERVICE_SID.test(sid)) throw new Error("A service must carry its observed NT SERVICE SID.");
  if (sidType !== "restricted") throw new Error("A service SID type must be restricted.");
  if (!["demand", "auto"].includes(startType)) throw new Error("A service start type must be demand or auto.");
  if (JSON.stringify(requiredPrivileges) !== JSON.stringify(PRIVILEGES)) throw new Error("A service may hold only SeChangeNotifyPrivilege.");
  return definition;
}

function validateRecord(record) {
  if (!validateRecordSchema(record)) throw new Error(`Invalid install record: ${ajv.errorsText(validateRecordSchema.errors)}`);
  const { principals: p, services: s, paths } = record;
  if (s.issuer.serviceName === s.receiver.serviceName) throw new Error("Issuer and receiver services must differ.");
  const others = [p.installer.observedSid, p.caller.observedSid, p.worker.observedSid];
  for (const role of ROLES) {
    if (p[role].accountName !== `NT SERVICE\\${s[role].serviceName}`) throw new Error(`The ${role} account must be its own service's virtual account.`);
    if (!SERVICE_SID.test(p[role].observedSid) || others.includes(p[role].observedSid))
      throw new Error(`The ${role} SID must be canonical and distinct from installer, caller and worker.`);
    if (s[role].binaryPath.toLowerCase().startsWith(`${paths.stateDirectory.toLowerCase()}\\`))
      throw new Error("Service binaries must stay outside mutable state.");
  }
  if (p.issuer.observedSid === p.receiver.observedSid) throw new Error("Issuer and receiver SIDs must differ.");
  if (s.issuer.binaryPath.toLowerCase() === s.receiver.binaryPath.toLowerCase()) throw new Error("Issuer and receiver binaries must differ.");
  return record;
}

const subtreeOf = (record) => `${record.paths.protectedRoot}\\issuer`;
const definitionsOf = (record) => ROLES.map((role) => validateWindowsServiceDefinition({
  role, serviceName: record.services[role].serviceName, binPath: `"${record.services[role].binaryPath}"`,
  obj: record.principals[role].accountName, sid: record.principals[role].observedSid, sidType: record.services[role].sidType,
  startType: record.services[role].startType, requiredPrivileges: PRIVILEGES }));

// subtreeExists(path) is the installer's observation and must answer true or false; anything else refuses (P6.1).
export function planWindowsIssuerInstall(record, { subtreeExists } = {}) {
  validateRecord(record);
  const subtree = subtreeOf(record);
  if (typeof subtreeExists !== "function") throw new Error("The protected subtree must be observed before planning.");
  let exists;
  try { exists = subtreeExists(subtree); } catch (error) { throw new Error("The protected subtree could not be observed.", { cause: error }); }
  if (exists !== false) throw new Error(exists === true ? "The protected subtree already exists." : "The protected subtree could not be observed.");
  const services = definitionsOf(record);
  return { mode: "plan", installId: record.installId, services, steps: [
    { action: "create-protected-subtree", path: subtree, owner: `*${record.principals.installer.observedSid}`, requireAbsent: true },
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
