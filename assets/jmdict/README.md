Place bundled JMdict assets in this folder.

Run `npm run dictionary:bundle` to download the latest English JMDict-Simplified JSON as `jmdict-eng.json`.

Notes:

- `jmdict-eng.json` is not stored in Git because it is too large for normal GitHub pushes.
- After cloning the repo, run `npm run dictionary:bundle` to fetch it locally.
- If you already have a copy, you can manually place `jmdict-eng.json` in this folder.
- End users of a packaged app do not need to do this step; packaged builds include this folder as an app resource.

The packaged Electron app includes this folder as an extra resource, and the main process builds a local `jmdict-simplified-node` cache in the user data directory on first launch.
