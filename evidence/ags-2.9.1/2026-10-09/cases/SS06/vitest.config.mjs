import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({root: fileURLToPath(new URL('.', import.meta.url)), test: {include: ['SS06.test.ts'], testTimeout: 10000, hookTimeout: 10000}});
