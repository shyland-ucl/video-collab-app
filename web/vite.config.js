import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    globals: true,
    // jsdom + userEvent renders are slow under parallel load on some machines;
    // the default 5s occasionally trips a genuinely-passing test (a flake, not a
    // real failure). A higher ceiling removes the flake without weakening any
    // assertion.
    testTimeout: 15000,
    // supabaseClient.js throws at import time when these are unset, so ANY
    // suite whose graph reaches it (ttsService -> lib/events -> supabaseClient,
    // which ConfirmEditDialog pulls in) fails to collect. Neither CI nor a
    // fresh clone has a .env.local, so these placeholders keep the suite
    // runnable everywhere. Tests never talk to Supabase — every component test
    // mocks the client or is handed one — so the values only have to exist.
    env: {
      VITE_SUPABASE_URL: 'http://localhost:54321',
      VITE_SUPABASE_ANON_KEY: 'test-anon-key',
    },
  },
})
