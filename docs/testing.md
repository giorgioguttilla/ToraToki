# Testing

## Commands

- `npm test` runs the unit suite with Vitest.
- `npm run test:watch` runs Vitest in watch mode.
- `npm run typecheck` runs the TypeScript compiler without emitting files.
- `npm run dev` starts the Electron app for manual validation.
- `npm run make` builds the packaged app for release-style validation.

## What is covered

The current unit suite focuses on pure, stable logic that is easy to exercise without Electron:

- Shared SRS labels and shortcuts in `src/shared/srs-review.ts`
- FSRS conversion and preview helpers in `src/srs/fsrs.ts`
- Database helper logic in `src/database.ts`
- Chat correction sanitizing and JSON parsing in `src/database.ts`
- SRS export formatting in `src/database.ts`

## What is not covered yet

- Electron window creation and main-process startup
- IPC wiring end-to-end
- Renderer interaction flows
- Packaged app startup beyond manual smoke testing

## Suggested additions

- A small test for chat prompt construction in `src/ChatLandingApp.tsx`
- A test for SRS item selection and ranking helpers in `src/database.ts`
- A test for dictionary entry formatting when the helper surface is split out further
