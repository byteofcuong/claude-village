import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: { provider: 'v8', include: ['src/server/**'], exclude: ['src/server/main.ts'], reporter: ['text-summary'] },
  },
});
