// B14-q-a3-1b: deterministic C# builds with the isolated Roslyn pinned in roslyn.lock.json.
// The build uses only the committed lock beside this module (pinned by its sha256) and the approved toolchain
// root; callers cannot pass another lock, root or compiler. Before every build the toolchain is checked against
// that lock (version, source, nupkg hash, per-file sha256, per-file Authenticode status and full subject); any
// difference or failed lookup refuses without building, re-downloading or falling back.
// buildTwice compiles the same input twice with /deterministic+ into a new keepDir, keeps both originals and
// compares them.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { verifyRoslyn } from "./fetch-roslyn.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const WINPS = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0");
const POWERSHELL = join(WINPS, "powershell.exe");
const LANGVERSION = "latest";
const ROOT = "D:/codex/거버전스 3.0/ags-toolchain/roslyn";
const LOCK = new URL("./roslyn.lock.json", import.meta.url);
const LOCK_SHA256 = "b848280314a39e82404d39d05aff57cff9d4fc1ddfde997462f243f99c003531";

// Windows PowerShell 5.1 with its in-box modules only: an inherited PSModulePath can make it load PowerShell 7's
// Microsoft.PowerShell.Security, which reports an empty status. Only the child's environment is changed.
function readAuthenticode(dir, paths) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PSMODULEPATH"));
  env.PSModulePath = join(WINPS, "Modules");
  const script = "$ErrorActionPreference = 'Stop'; Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'), (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1'); ConvertTo-Json -Compress -InputObject @($input | ForEach-Object { $s = Get-AuthenticodeSignature -LiteralPath $_; [pscustomobject]@{ path = $_; status = [string]$s.Status; signer = $s.SignerCertificate.Subject } })";
  const result = spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], { cwd: dir, input: paths.join("\n"), encoding: "utf8", env });
  const failed = (why) => new Error(`Authenticode lookup failed: ${why}`);
  if (result.error || result.status !== 0) throw failed(result.error?.message ?? `exit ${result.status} ${result.stderr}`);
  let rows;
  try { rows = JSON.parse(result.stdout); } catch { throw failed("the output is not JSON"); }
  if (!Array.isArray(rows)) throw failed("the output is not a list");
  const seen = new Map();
  for (const row of rows) {
    if (!paths.includes(row?.path) || seen.has(row.path) || typeof row.status !== "string" || !row.status) throw failed(`unexpected, repeated or empty row for ${row?.path}`);
    seen.set(row.path, row);
  }
  const missing = paths.filter((path) => !seen.has(path));
  if (missing.length) throw failed(`no row for ${missing.join(", ")}`);
  return seen;
}

// Checks a toolchain folder against a lock (the build itself only ever passes the committed lock and ROOT).
export function verifyToolchain({ root, lock }) {
  const id = lock.package.toLowerCase();
  if (lock.source !== `https://api.nuget.org/v3-flatcontainer/${id}/${lock.version}/${id}.${lock.version}.nupkg`) throw new Error("The lock source is not the official nuget.org URL.");
  if (!lock.files[lock.compiler]?.authenticode) throw new Error(`The lock compiler ${lock.compiler} is not one of its signed files.`);
  const csc = verifyRoslyn({ root, version: lock.version, lock });
  const signed = Object.keys(lock.files).filter((path) => lock.files[path].authenticode);
  const seen = readAuthenticode(join(root, lock.version), signed);
  for (const path of signed) {
    const expected = lock.files[path].authenticode;
    const actual = seen.get(path);
    if (actual.status !== expected.status || actual.signer !== expected.signer) throw new Error(`${path}: Authenticode differs from the lock.`);
  }
  return csc;
}

function committedToolchain() {
  const bytes = readFileSync(LOCK);
  if (sha256(bytes) !== LOCK_SHA256) throw new Error("roslyn.lock.json is not the committed lock.");
  return verifyToolchain({ root: ROOT, lock: JSON.parse(bytes) });
}

// Everything that decides the output bytes; two builds are the same input only if these match exactly.
export function inputOf({ compiler, sources, references = [], cwd, out, pathmap = `${cwd}=/_/`, langversion = LANGVERSION }) {
  const file = (path) => ({ path: resolve(path), sha256: sha256(readFileSync(path)) });
  return { compiler: file(compiler), sources: sources.map(file), references: references.map(file), cwd: resolve(cwd),
    out: resolve(out), pathmap, langversion, options: ["/nologo", "/noconfig", "/nostdlib+", "/deterministic+", "/debug-", "/target:exe"] };
}

export function compareBuilds(a, b) {
  if (JSON.stringify(a.input) !== JSON.stringify(b.input)) throw new Error("The two builds are not the same input.");
  return a.sha256 === b.sha256;
}

export function buildTwice({ sources, references = [], cwd, out, keepDir, ...rest }) {
  const passed = Object.keys(rest);
  if (passed.length) throw new Error(`The compiler comes only from the committed lock and the approved root; callers cannot pass ${passed.join(", ")}.`);
  if (existsSync(keepDir)) throw new Error(`${keepDir} already exists; each build needs a new run folder.`);
  const runs = [];
  let args;
  for (const run of ["run-1", "run-2"]) {
    const csc = committedToolchain();
    if (!isAbsolute(csc)) throw new Error("The lock-verified compiler path must be absolute.");
    const input = inputOf({ compiler: csc, sources, references, cwd, out });
    args = [...input.options, `/langversion:${input.langversion}`, `/pathmap:${input.pathmap}`, `/out:${input.out}`,
      ...input.references.map((r) => `/reference:${r.path}`), ...input.sources.map((s) => s.path)];
    if (existsSync(input.out)) throw new Error(`${input.out} already exists.`);
    if (run === "run-1") {
      mkdirSync(dirname(keepDir), { recursive: true });
      mkdirSync(keepDir); // fails if another process created it meanwhile
    }
    mkdirSync(join(input.out, ".."), { recursive: true });
    const result = spawnSync(csc, args, { cwd: input.cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`csc failed: ${result.stdout}${result.stderr}`);
    // Keep each original: move it out of the shared /out path before the next build.
    const kept = join(keepDir, run, basename(input.out));
    mkdirSync(join(kept, ".."), { recursive: true });
    renameSync(input.out, kept);
    runs.push({ input, path: kept, sha256: sha256(readFileSync(kept)) });
  }
  const identical = compareBuilds(runs[0], runs[1]);
  if (!identical) throw new Error(`Deterministic builds differ: ${runs[0].sha256} vs ${runs[1].sha256}`);
  return { args, input: runs[0].input, runs: runs.map(({ path, sha256: digest }) => ({ path, sha256: digest })), identical };
}
