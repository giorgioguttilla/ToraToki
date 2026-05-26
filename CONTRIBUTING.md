# Contributing

Thanks for contributing to ToraChat.

## Quick start

1. Run one-command setup.

   npm run setup

2. Start the app.

   npm run dev

## Before opening a PR

Run these checks locally:

- npm test
- npm run typecheck
- npm run lint

For packaging-related changes, also run:

- npm run make

## Contribution guidelines

- Keep changes focused and small.
- Add or update tests for pure logic changes.
- Prefer placing logic in pure helpers when possible.
- Keep database and filesystem access in the Electron main process.
- Do not enable Node integration in the renderer.
- Use the typed preload bridge for renderer-to-main communication.
- Keep existing IPC channel contracts stable unless a migration is intentionally planned.

## Project map

- src/main.ts: Electron startup and IPC registration
- src/preload.ts: typed bridge exposed to renderer
- src/database.ts: SQLite, SRS, and dictionary logic
- src/ChatLandingApp.tsx: main chat UI flow
- src/SrsReviewPage.tsx: review UI flow
- src/srs/: FSRS and review helper utilities

## Pull request checklist

- Clear summary of what changed and why
- Notes on user-facing behavior changes
- Test evidence from local run commands
- Follow-up items called out if work is intentionally partial
