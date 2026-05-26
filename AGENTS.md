# ToraToki Agent Guide

## Scope

This repository is a local-first Japanese learning Electron app. Keep changes small, focused, and consistent with the existing Electron Forge + Vite + React structure.

## Non-negotiables

- Keep `better-sqlite3` in the Electron main process only.
- Expose filesystem and database operations through the typed preload bridge.
- Do not enable Node integration in the renderer.
- Treat renderer input as untrusted.
- Preserve the `@/` alias and the existing TypeScript conventions.

## High-value areas

- `src/database.ts` contains the SQLite, JMdict, and SRS logic.
- `src/main.ts` owns app startup, IPC registration, and main-process orchestration.
- `src/preload.ts` defines the renderer bridge surface.
- `src/ChatLandingApp.tsx` and `src/SrsReviewPage.tsx` contain the main UI flows.
- `src/srs/` holds the pure SRS helpers that are easiest to unit test.

## When editing

- Prefer pure helpers when you need test coverage.
- Keep UI changes isolated to the view that needs them.
- Do not change IPC channel names casually.
- Update or add tests for pure logic changes.

## Validation

- `npm test` for unit coverage.
- `npm run typecheck` for TypeScript checks.
- `npm run dev` for local app behavior.
- `npm run make` for packaged build validation.
