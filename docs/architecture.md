# Architecture

## Overview

ToraChat is built around three layers:

- Electron main process for app startup, IPC, SQLite, and file access
- Preload bridge for typed renderer access to privileged operations
- React renderer for UI, interaction, and local state

## Core paths

### Main process

`src/main.ts` is responsible for:

- creating the Electron window
- registering IPC handlers
- initializing the databases
- coordinating app lifecycle concerns

### Data layer

`src/database.ts` is the main persistence and dictionary module. It handles:

- SRS storage
- chat session storage
- JMdict-backed dictionary lookup
- chat message sanitizing and export formatting
- SRS review queue generation and item mutation

### Preload bridge

`src/preload.ts` exposes a typed `window.languageApp` API to the renderer. The renderer should use this instead of calling IPC channels directly.

### Renderer

The main renderer entry is `src/ChatLandingApp.tsx`, with the dedicated review flow in `src/SrsReviewPage.tsx`.

## Japanese text flow

1. Renderer submits text or a review action.
2. Main process and database helpers resolve local SRS or dictionary state.
3. The renderer displays furigana, dictionary info, review outcomes, and correction data.

## Storage

- SQLite is used for SRS and chat data.
- JMdict is imported locally and queried offline.
- `better-sqlite3` stays in the main process.

## Packaging notes

- The app is packaged with Electron Forge and Vite.
- Runtime native dependencies must be included in packaged builds.
- The renderer bundle should stay free of direct Node access.
