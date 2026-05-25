# GitHub Copilot instructions

## Product goal

Build a local-first Japanese language learning Electron app with:

- Electron Forge + Vite
- React + shadcn/ui in the renderer
- `@patdx/kuromoji` for Japanese tokenization
- `kuroshiro` for reading/furigana-related helpers
- JMdict imported into a local SQLite database
- `better-sqlite3` for both dictionary and SRS storage
- Kokoro 82M later, not in the current milestone

## Architecture rules

- Keep `better-sqlite3` in the Electron main process only.
- Expose database and filesystem operations through a narrow preload bridge.
- Do not enable Node integration in the renderer.
- Prefer typed preload APIs over direct IPC string usage scattered across the UI.
- Treat the renderer as untrusted input.

## Japanese text pipeline guidance

- Prefer `@patdx/kuromoji` for tokenization because it is TypeScript-friendly, ESM-first, promise-based, and better suited to browser/Electron renderer scenarios.
- Important compatibility note: `kuroshiro-analyzer-kuromoji` depends on the legacy `kuromoji` package, not `@patdx/kuromoji`.
- If Kuroshiro needs analyzer-style integration with `@patdx/kuromoji`, write a thin adapter instead of silently mixing incompatible packages.
- Preserve token fields such as surface form, basic form, reading, pronunciation, and POS metadata for hover definitions and furigana rendering.

## Dictionary and storage guidance

- JMdict XML is the source of truth for dictionary data.
- Preserve `ent_seq` during import as the stable JMdict entry identifier.
- Keep dictionary data and SRS data in separate SQLite files.
- Use WAL mode and idempotent migrations.
- Keep EDRDG attribution and licensing notes in the repository and packaged app once JMdict data is bundled.

## UI guidance

- Use React + shadcn/ui components from source files inside the repo.
- Reuse the `cn()` helper and `@/` aliases.
- Optimize for reading ergonomics: dense information, strong typography, keyboard support, and fast hover/focus states.
- Furigana rendering should prefer semantic HTML like `<ruby>`, `<rt>`, and accessible hover/focus behavior.

## Milestone focus

### Milestone 1

Set up the Electron app, renderer stack, documentation, and local database foundation.

### Milestone 2

Display Japanese text with furigana and hover definitions powered by local tokenization plus JMdict lookups.

## Avoid

- Putting native modules in the renderer bundle.
- Relying on remote dictionary APIs for the core reading experience.
- Building UI components outside the current shadcn/Tailwind setup unless there is a clear reason.
- Hiding the `@patdx/kuromoji` vs `kuroshiro-analyzer-kuromoji` compatibility gap.
