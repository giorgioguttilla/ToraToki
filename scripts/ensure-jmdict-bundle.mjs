import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const bundledJsonPath = path.join(projectRoot, 'assets', 'jmdict', 'jmdict-eng.json');
const bundlerScriptPath = path.join(projectRoot, 'scripts', 'bundle-jmdict.mjs');

if (existsSync(bundledJsonPath)) {
  console.log(`Dictionary bundle already present at ${bundledJsonPath}. Skipping download.`);
  process.exit(0);
}

console.log('Dictionary bundle not found. Running bundle...');

const result = spawnSync(process.execPath, [bundlerScriptPath], {
  cwd: projectRoot,
  stdio: 'inherit',
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
