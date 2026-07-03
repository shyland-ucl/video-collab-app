import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: '.',
  timeout: 180_000,
  workers: 1,
  globalSetup: './demo-setup.mjs',
  globalTeardown: './demo-teardown.mjs',
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1280, height: 720 },
    video: { mode: 'on', size: { width: 1280, height: 720 } },
  },
  webServer: [
    { command: 'npm run dev:web', port: 5173, reuseExistingServer: true, timeout: 60_000 },
    { command: 'npm run dev:server', port: 3001, reuseExistingServer: true, timeout: 60_000 },
  ],
})
