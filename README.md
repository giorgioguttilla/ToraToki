# ToraToki

虎時へようこそ！

ToraToki is a local-first Japanese language learning desktop app meant to streamline acquisition and built fluency through the power of spaced repetition. ToraToki allows you to build a review deck and actually _practice_ with them via conversation with an integrated chatbot, enhancing the otherwise abstracted and contextless experience of flashcard review and facilitating easy mining of more review material.

## ToraToki has
- A BYOT (Bring Your Own Token) LLM chat interface that integrates with your personal review deck to use _your_ words in context in _your_ conversations
- A fully-fledged SRS flashcard review system built into the application, with non-obtrusive badge updates for items up for review and integration with LLM chat
- Automatic corrections for user messages
- Full Jisho/furigana reading support - one-click auto card generation
- Ability to use [LM Studio](https://lmstudio.ai/) for local inference
- Completely free. All data stays on your machine

Contributing guide: [CONTRIBUTING.md](CONTRIBUTING.md)

## Requirements

- Node.js 20 or newer
- npm
- macOS, Windows, or Linux for development
- macOS only if you want to regenerate the app icon assets with the included script

## Install

1. Clone the repository.
2. Run one-command setup:

```bash
npm run setup
```

This installs dependencies and bundles JMdict only when `assets/jmdict/jmdict-eng.json` is missing.

## Run ToraToki

Start the desktop app in development mode:

```bash
npm run dev
```

The app launches Electron Forge with Vite-powered renderer hot reload.

## Package ToraToki

To build distributables for sharing:

```bash
npm run make
```

For a local packaged build without creating an installer:

```bash
npm run package
```

## Useful scripts

- `npm run dev` - launch ToraToki in development mode
- `npm run setup` - install dependencies and conditionally bundle JMdict
- `npm run bundle` - bundle JMdict only if not already present
- `npm run icon:generate` - regenerate the macOS app icon assets
- `npm run lint` - run ESLint
- `npm run typecheck` - run TypeScript type-checking
- `npm run package` - create a local packaged build
- `npm run make` - create distributables with Electron Forge

## Dictionary data

The app uses JMdict-derived data for local dictionary lookups. The bundled JSON is intentionally not committed to Git because it is large. Run `npm run bundle` when `assets/jmdict/jmdict-eng.json` is missing.

To force a fresh re-bundle, delete `assets/jmdict/jmdict-eng.json` and run `npm run bundle` again.

On first launch after the dictionary is present, the app creates its local cache in the user data directory. That may take a little while once; after that, startup is normal.

## Project layout

- `src/` - Electron main process, preload bridge, and React renderer code
- `assets/` - local bundled resources used during development
- `public/` - packaged static assets used by the app and demos
- `docs/` - attribution and license notes
- `scripts/` - utility scripts for bundling assets and generating icons

## Attribution

JMdict content is distributed by EDRDG. See [docs/EDRDG.md](docs/EDRDG.md) for attribution and usage notes.
