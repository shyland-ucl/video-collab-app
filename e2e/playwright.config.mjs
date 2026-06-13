import { defineConfig } from '@playwright/test'

// Two-browser live-collaboration smoke (Phase 1c Task 12). Runs against the
// LIVE Supabase project + LIVE Gemini + a LOCAL web (5173) and server (3001).
// globalSetup provisions a creator+helper+project+one processed video and
// writes credentials to e2e/.state.json; globalTeardown cleans it all up.
export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  globalSetup: './setup/globalSetup.mjs',
  globalTeardown: './setup/globalTeardown.mjs',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  webServer: [
    { command: 'npm run dev:web', port: 5173, reuseExistingServer: true, timeout: 60_000 },
    { command: 'npm run dev:server', port: 3001, reuseExistingServer: true, timeout: 60_000 },
  ],
})
