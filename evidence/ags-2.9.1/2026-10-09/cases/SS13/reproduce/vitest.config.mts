import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({ test: { root: fileURLToPath(new URL('.', import.meta.url)), include: ['SS13.test.ts'], maxWorkers: 1 } });
