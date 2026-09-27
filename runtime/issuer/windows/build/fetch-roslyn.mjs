// B14-q-a3-1a: fetch the isolated Roslyn compiler once from nuget.org and pin it in roslyn.lock.json.
// `node fetch-roslyn.mjs fetch <toolchainRoot>` downloads, checks and writes the lock (refuses when the
// version folder already exists; no retry, mirror or other package). `verifyRoslyn` checks a toolchain
// folder against the lock before any use. Nothing here changes PATH, the registry, environment variables
// or ACLs, and it never touches an in-box csc.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = "Microsoft.Net.Compilers.Toolset";
const VERSION = "5.9.0";
const ID = PACKAGE.toLowerCase();
const SOURCE = `https://api.nuget.org/v3-flatcontainer/${ID}/${VERSION}/${ID}.${VERSION}.nupkg`;
const REGISTRATION = `https://api.nuget.org/v3/registration5-semver1/${ID}/${VERSION}.json`;
const COMPILER = "package/tasks/net472/csc.exe";
const LOCK_PATH = join(dirname(fileURLToPath(import.meta.url)), "roslyn.lock.json");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha512 = (bytes) => createHash("sha512").update(bytes).digest("base64");
const listFiles = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
  .sort();

// Returns the absolute compiler path only when <root>/<version> is exactly the locked package.
export function verifyRoslyn({ root, version, lock }) {
  if (version !== lock.version) throw new Error(`Roslyn ${version} is not the locked version ${lock.version}.`);
  const dir = join(root, version);
  const nupkg = join(dir, lock.nupkg.file);
  if (!existsSync(nupkg) || sha512(readFileSync(nupkg)) !== lock.nupkg.sha512) throw new Error(`${lock.nupkg.file}: nupkg does not match the lock.`);
  const actual = listFiles(join(dir, "package")).map((path) => `package/${path}`);
  const expected = Object.keys(lock.files).sort();
  const extra = actual.filter((path) => !lock.files[path]);
  const missing = expected.filter((path) => !actual.includes(path));
  if (extra.length || missing.length) throw new Error(`Package files differ from the lock: extra ${extra.join(", ")}; missing ${missing.join(", ")}`);
  for (const path of expected) {
    if (sha256(readFileSync(join(dir, path))) !== lock.files[path].sha256) throw new Error(`${path} does not match the lock.`);
  }
  return join(dir, lock.compiler);
}

// In-box Windows tools only, by absolute path (a PATH lookup could pick another tar or shell).
const SYSTEM32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const TAR = join(SYSTEM32, "tar.exe");
const POWERSHELL = join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe");
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function authenticode(packageDir, peFiles) {
  const script = "$input | ForEach-Object { $s = Get-AuthenticodeSignature -LiteralPath $_; [pscustomobject]@{ path = $_; status = [string]$s.Status; signer = $s.SignerCertificate.Subject } } | ConvertTo-Json -Compress";
  const out = run(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], { cwd: packageDir, input: peFiles.join("\n") });
  return [JSON.parse(out)].flat();
}

const NUPKG = `${ID}.${VERSION}.nupkg`;

// Downloads the nupkg exactly once; an existing version folder refuses (no retry, mirror or other package).
async function fetchRoslyn(root) {
  const dir = join(root, VERSION);
  if (existsSync(dir)) throw new Error(`${dir} already exists; the package is fetched once.`);
  const response = await fetch(SOURCE);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, NUPKG), Buffer.from(await response.arrayBuffer()));
  return pinRoslyn(root);
}

// Checks the downloaded nupkg against the hash nuget.org publishes, extracts it and writes the lock.
async function pinRoslyn(root) {
  const dir = join(root, VERSION);
  const registration = await (await fetch(REGISTRATION)).json();
  const catalog = await (await fetch(registration.catalogEntry)).json();
  if (catalog.packageHashAlgorithm !== "SHA512") throw new Error(`Unexpected hash algorithm ${catalog.packageHashAlgorithm}.`);
  const nupkgFile = NUPKG;
  const digest = sha512(readFileSync(join(dir, nupkgFile)));
  if (digest !== catalog.packageHash) throw new Error(`nupkg sha512 ${digest} differs from nuget.org ${catalog.packageHash}.`);
  if (existsSync(join(dir, "package"))) throw new Error(`${join(dir, "package")} already exists.`);
  mkdirSync(join(dir, "package"));
  run(TAR, ["-xf", join(dir, nupkgFile), "-C", join(dir, "package")]);
  const packageDir = join(dir, "package");
  const files = listFiles(packageDir);
  const peFiles = files.filter((path) => readFileSync(join(packageDir, path)).subarray(0, 2).toString("latin1") === "MZ");
  const signatures = new Map(authenticode(packageDir, peFiles).map((s) => [s.path, s]));
  const lock = {
    package: PACKAGE, version: VERSION, source: SOURCE, compiler: COMPILER,
    nupkg: { file: nupkgFile, sha512: digest, publishedSha512: catalog.packageHash, catalogEntry: registration.catalogEntry },
    files: Object.fromEntries(files.map((path) => {
      const signature = signatures.get(path);
      return [`package/${path}`, { sha256: sha256(readFileSync(join(packageDir, path))),
        ...(signature ? { authenticode: { status: signature.status, signer: signature.signer } } : {}) }];
    })),
  };
  const unsigned = peFiles.filter((path) => signatures.get(path)?.status !== "Valid" || !/O=Microsoft Corporation/.test(signatures.get(path)?.signer ?? ""));
  writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
  if (unsigned.length) throw new Error(`PE files without a valid Microsoft Corporation signature: ${unsigned.join(", ")}`);
  return verifyRoslyn({ root, version: VERSION, lock });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const command = { fetch: fetchRoslyn, pin: pinRoslyn }[process.argv[2]];
  if (!command || !process.argv[3]) throw new Error("usage: fetch-roslyn.mjs fetch|pin <toolchainRoot>");
  console.log(await command(process.argv[3]));
}
