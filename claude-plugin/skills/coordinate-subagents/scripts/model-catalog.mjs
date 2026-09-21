import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assert, keys, ORIGINS, ROLES, seal, validateCatalog, validatePolicy } from './model-routing-core.mjs';

export const defaultCatalogDirectory = fileURLToPath(new URL('../references/model-catalog/', import.meta.url));
function localFile(directory, relative, expectedDigest = null) {
  assert(typeof relative === 'string' && !path.isAbsolute(relative) && !relative.split(/[\\/]/u).includes('..'), 'INVALID_CATALOG_PATH');
  const root = realpathSync(directory), file = realpathSync(path.join(root, relative));
  const rel = path.relative(root, file);
  assert(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'INVALID_CATALOG_PATH');
  const bytes = readFileSync(file);
  assert(bytes.length <= 2 * 1024 * 1024, 'CATALOG_TOO_LARGE');
  if (expectedDigest !== null) assert(createHash('sha256').update(bytes).digest('hex') === expectedDigest, 'CATALOG_FILE_DIGEST_MISMATCH');
  return JSON.parse(bytes.toString('utf8'));
}
export function catalogIndex(directory = defaultCatalogDirectory) {
  const index = localFile(directory, 'index.json');
  keys(index, ['schemaVersion','snapshotDate','providers','hostsFile','sourcesFile','hostsSha256','sourcesSha256']);
  assert(index.schemaVersion === '1.0.0' && Array.isArray(index.providers), 'INVALID_CATALOG');
  const seen = new Set();
  for (const p of index.providers) { keys(p, ['provider','file','sha256','roles']); assert(ORIGINS.includes(p.provider) && !seen.has(p.provider), 'ORIGIN_EXCLUDED'); seen.add(p.provider); assert(/^[a-f0-9]{64}$/u.test(p.sha256), 'INVALID_CATALOG'); }
  return index;
}
/** Index and only requested provider/role shards are read. No external I/O. */
export function loadCatalog({ directory = defaultCatalogDirectory, providers = null, role = null } = {}) {
  if (providers !== null) assert(Array.isArray(providers) && providers.every(p => ORIGINS.includes(p)), 'INVALID_FILTER');
  if (role !== null) assert(ROLES.includes(role), 'INVALID_FILTER');
  const index = catalogIndex(directory);
  const records = index.providers.filter(p => (providers === null || providers.includes(p.provider)) && (role === null || p.roles.includes(role)));
  const models = records.flatMap(p => {
    const shard = localFile(directory, p.file, p.sha256);
    keys(shard, ['schemaVersion','provider','models']); assert(shard.schemaVersion === '1.0.0' && shard.provider === p.provider && Array.isArray(shard.models), 'INVALID_CATALOG');
    assert(shard.models.every(m => m.modelOrigin === p.provider), 'ORIGIN_MISMATCH');
    return role === null ? shard.models : shard.models.filter(m => m.roles.includes(role));
  });
  return validateCatalog(seal({ schemaVersion: '1.0.0', snapshotDate: index.snapshotDate, models,
    hosts: localFile(directory, index.hostsFile, index.hostsSha256), sources: localFile(directory, index.sourcesFile, index.sourcesSha256) }, 'catalogDigest'));
}
export function loadPolicy(directory = defaultCatalogDirectory) { return validatePolicy(localFile(directory, 'policy.json')); }
export function queryCatalog(query = {}, directory = defaultCatalogDirectory) {
  keys(query, ['provider','role','model','includeSources'], []);
  const catalog = loadCatalog({ directory, providers: query.provider ? [query.provider] : null, role: query.role ?? null });
  const models = catalog.models.filter(m => !query.model || m.id === query.model || m.aliases.includes(query.model));
  return { schemaVersion: '1.0.0', catalogDigest: catalog.catalogDigest, models,
    ...(query.includeSources === true ? { sources: catalog.sources.filter(s => models.some(m => m.sourceIds.includes(s.id))) } : {}),
    liveVerified: false };
}
// A bundle shares one import.meta.url, so the file name keeps this CLI from running inside the bundled MCP server.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && import.meta.url.endsWith('/model-catalog.mjs')) {
  try {
    const [operation = 'index', value, ...extra] = process.argv.slice(2);
    assert(extra.length === 0 && ['index','validate','query'].includes(operation), 'USAGE', 'model-catalog.mjs index|validate|query [query.json]');
    if (operation === 'index') console.log(JSON.stringify(catalogIndex(), null, 2));
    else if (operation === 'validate') { const catalog = loadCatalog(); loadPolicy(); console.log(JSON.stringify({ valid: true, models: catalog.models.length, catalogDigest: catalog.catalogDigest })); }
    else console.log(JSON.stringify(queryCatalog(value ? JSON.parse(readFileSync(value,'utf8')) : {}), null, 2));
  } catch (error) { console.error(`${error.code ?? 'ERROR'}: ${error.message}`); process.exitCode = 1; }
}
