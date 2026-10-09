import { defineConfig } from 'vitest/config';
// Windows native helpers are transferred in memory; the forks pool's temporary
// module files can be unavailable in a managed Windows desktop environment.
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], testTimeout: 45_000, hookTimeout: 45_000, fileParallelism: false, pool: process.platform === 'win32' ? 'threads' : 'forks' } });
