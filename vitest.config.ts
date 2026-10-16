import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://assistant:dev@127.0.0.1:5433/assistant_test',
      MEMORY_ENABLED: 'false',
      APP_SECRET: 'test-secret-0123456789-abcdefghijklmnop',
      PUBLIC_URL: 'https://assistant.test',
      TARKA_API_KEY: 'test-key',
      DEFAULT_MODEL: 'qwen3.8-flash-next',
      SEARCH_PROVIDER: 'none',
    },
  },
});
