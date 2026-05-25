# ToraChat

A local-first Japanese learning desktop app built with Electron Forge, Vite, React, shadcn/ui, Kuromoji-based tokenization, SQLite, and JMdict-powered dictionary lookups.

## What ToraChat does

- Shows Japanese text with furigana
- Lets you hover or click words for dictionary information
- Stores SRS cards locally in SQLite
- Keeps the renderer UI-only and routes file/database access through Electron main + preload
- Works offline after the bundled dictionary assets are prepared

## Requirements

- Node.js 20 or newer
- npm
- macOS, Windows, or Linux for development
- macOS only if you want to regenerate the app icon assets with the included script

## Install

1. Clone the repository.
2. Install dependencies:

```bash
npm install
```

3. Prepare the bundled JMdict JSON used by the app:

```bash
npm run dictionary:bundle
```

This downloads `assets/jmdict/jmdict-eng.json` locally so the app can bundle it for development and packaging.

## Run ToraChat

Start the desktop app in development mode:

```bash
npm run dev
```

The app launches Electron Forge with Vite-powered renderer hot reload.

## Package ToraChat

To build distributables for sharing:

```bash
npm run make
```

For a local packaged build without creating an installer:

```bash
npm run package
```

## Useful scripts

- `npm run dev` - launch ToraChat in development mode
- `npm run dictionary:bundle` - download the bundled JMdict JSON
- `npm run icon:generate` - regenerate the macOS app icon assets
- `npm run lint` - run ESLint
- `npm run typecheck` - run TypeScript type-checking
- `npm run package` - create a local packaged build
- `npm run make` - create distributables with Electron Forge

## Dictionary data

The app uses JMdict-derived data for local dictionary lookups. The bundled JSON is intentionally not committed to Git because it is large. Run `npm run dictionary:bundle` once after cloning, or place the file at `assets/jmdict/jmdict-eng.json` yourself if you already have it.

On first launch after the dictionary is present, the app creates its local cache in the user data directory. That may take a little while once; after that, startup is normal.

## Project layout

- `src/` - Electron main process, preload bridge, and React renderer code
- `assets/` - local bundled resources used during development
- `public/` - packaged static assets used by the app and demos
- `docs/` - attribution and license notes
- `scripts/` - utility scripts for bundling assets and generating icons

## Attribution

JMdict content is distributed by EDRDG. See [docs/EDRDG.md](docs/EDRDG.md) for attribution and usage notes.

## Development notes

- `better-sqlite3` stays in the Electron main process only.
- The renderer is kept untrusted and communicates through the preload bridge.
- Furigana rendering prefers semantic HTML with `<ruby>` and `<rt>`.
- ToraChat is designed to work offline once local assets are available.
