# video-collab-app

Collaborative video editing for blind/low-vision creators and their sighted helpers.

Productized from the `video-collab-probe` research platform (kept frozen as the study artifact).
Design spec: see [`docs/superpowers/specs/2026-06-10-product-phase1-backend-design.md`](docs/superpowers/specs/2026-06-10-product-phase1-backend-design.md).

## Structure
- `web/` — Vite + React SPA (talks to Supabase directly; mobile-first)
- `server/` — Express service for FFmpeg + Gemini work (secrets live here, never in the browser)
- `supabase/` — database migrations

## Dev
1. `npm install`
2. Copy `web/.env.example` → `web/.env.local` and `server/.env.example` → `server/.env`, fill in values
3. `npm run dev:web` and `npm run dev:server`
