import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration tests share one real database and truncate between cases,
    // so test files must not run in parallel with each other.
    fileParallelism: false,
  },
});
