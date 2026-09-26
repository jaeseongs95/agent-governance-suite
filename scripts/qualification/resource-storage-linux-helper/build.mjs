#!/usr/bin/env node
// Builds the B14-n-l helper with fixed flags and prints source/artifact digests.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE = 'resource-storage-linux.c';
export const ARTIFACT = 'resource-storage-linux';
export const COMPILE_FLAGS = Object.freeze([
  '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fno-ident', '-ffile-prefix-map=.=.',
  '-Wl,--build-id=none', '-Wl,-z,relro,-z,now',
]);

const helperDirectory = fileURLToPath(new URL('.', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function compilerVersion() {
  const child = spawnSync('cc', ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  if (child.error || child.status !== 0) return null;
  return child.stdout.split('\n')[0].trim();
}

export function buildHelper(outputDirectory) {
  if (process.platform !== 'linux') throw new Error('BUILD_ENVIRONMENT_UNAVAILABLE');
  if (!isAbsolute(outputDirectory) || !existsSync(outputDirectory)) throw new Error('OUTPUT_DIRECTORY_INVALID');
  const compiler = compilerVersion();
  if (compiler === null) throw new Error('BUILD_ENVIRONMENT_UNAVAILABLE');
  const output = join(outputDirectory, ARTIFACT);
  const child = spawnSync('cc', [...COMPILE_FLAGS, '-o', output, SOURCE], {
    cwd: helperDirectory, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
  });
  if (child.error || child.status !== 0) throw new Error(`BUILD_FAILED ${child.stderr ?? ''}`.trim());
  return {
    compiler,
    flags: [...COMPILE_FLAGS],
    sourceSha256: sha256(readFileSync(join(helperDirectory, SOURCE))),
    artifactSha256: sha256(readFileSync(output)),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outputDirectory = process.argv[2];
  if (!outputDirectory) {
    console.error('usage: build.mjs <absolute-output-directory>');
    process.exit(1);
  }
  console.log(JSON.stringify(buildHelper(outputDirectory)));
}
