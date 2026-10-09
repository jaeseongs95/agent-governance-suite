import { defineConfig } from 'vitest/config';
export default defineConfig({test: {include: ['reproduce/SS36.test.ts'], testTimeout: 30000}});
