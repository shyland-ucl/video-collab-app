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
  },
})
