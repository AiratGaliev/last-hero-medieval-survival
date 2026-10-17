# Base44 Setup Notes

## What this is
A Phaser 4 bullet-heaven roguelite game ("Последний герой: Средневековое выживание")
built with Vite + TypeScript. **No backend, no database, no external services** —
it's a pure static frontend game. No credentials are needed to run it.

## Running in the sandbox
`docker compose -f docker-compose.base44.yml up -d` starts a `node:22` container
that bind-mounts the repo, runs `npm install` (the committed `package-lock.json`
is out of sync, so `npm ci` fails — `npm install` reconciles it), then starts
`vite` (the dev server) on port 3000.

- Vite config already binds `0.0.0.0` (`host: true`) and allows all hosts
  (`allowedHosts: true`), so no sandbox-specific host/origin overrides are needed.
- Dependencies live in a named volume (`node_modules`) so they survive restarts.
- Healthcheck probes `http://localhost:3000/` via `fetch()`.

## Verifying it works
`curl -s http://localhost:3000/` returns the HTML with the injected
`/@vite/client` HMR script — that confirms the live dev server is serving
from source, not a prebuilt bundle. The game canvas mounts in `#game`.

## Commands
| Command | What |
|---|---|
| `npm run dev` | Vite dev server on :3000 (used by compose) |
| `npm run build` | Production build → `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run test:e2e` | Playwright smoke tests |
