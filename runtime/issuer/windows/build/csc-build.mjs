// B14-q-a3-1b: deterministic C# builds with the isolated Roslyn pinned in roslyn.lock.json.
// Before every build the toolchain is checked against the lock (version, source, nupkg hash, per-file sha256,
// per-file Authenticode status and full subject); any difference refuses without building, re-downloading or
// falling back. The compiler is only ever the lock-verified absolute path, never PATH or an in-box csc.
// buildTwice compiles the same input twice with /deterministic+, keeps both originals and compares them.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, existsSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { verifyRoslyn } from "./fetch-roslyn.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const POWERSHELL = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const LANGVERSION = "latest";

function readAuthenticode(dir, paths) {
  const script = "$input | ForEach-Object { $s = Get-AuthenticodeSignature -LiteralPath $_; [pscustomobject]@{ path = $_; status = [string]$s.Status; signer = $s.SignerCertificate.Subject } } | ConvertTo-Json -Compress";
  const result = spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], { cwd: dir, input: paths.join("\n"), encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Authenticode could not be read: ${result.stderr}`);
  return new Map([JSON.parse(result.stdout)].flat().map((s) => [s.path, s]));
}

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
    if (actual?.status !== expected.status || actual?.signer !== expected.signer) throw new Error(`${path}: Authenticode differs from the lock.`);
  }
  return csc;
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

export function buildTwice({ root, lock, compiler, sources, references = [], cwd, out, keepDir }) {
  if (compiler !== undefined) throw new Error("Only the lock-verified compiler may be used; callers cannot choose one.");
  const runs = [];
  let args;
  for (const run of ["run-1", "run-2"]) {
    const csc = verifyToolchain({ root, lock });
    if (!isAbsolute(csc)) throw new Error("The lock-verified compiler path must be absolute.");
    const input = inputOf({ compiler: csc, sources, references, cwd, out });
    args = [...input.options, `/langversion:${input.langversion}`, `/pathmap:${input.pathmap}`, `/out:${input.out}`,
      ...input.references.map((r) => `/reference:${r.path}`), ...input.sources.map((s) => s.path)];
    if (existsSync(input.out)) throw new Error(`${input.out} already exists.`);
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
