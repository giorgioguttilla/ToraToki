import { cp, mkdir, rm, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultSourcePath = path.join(projectRoot, 'icon_512x512@2x@2x.png');
const sourceArg = process.argv[2];
const sourcePath = sourceArg
  ? path.resolve(process.cwd(), sourceArg)
  : defaultSourcePath;
const outputDirectory = path.join(projectRoot, 'assets', 'icons');
const iconsetDirectory = path.join(outputDirectory, 'app-icon.iconset');
const pngOutputPath = path.join(outputDirectory, 'app-icon.png');
const icnsOutputPath = path.join(outputDirectory, 'app-icon.icns');

const iconsetEntries = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

const runCommand = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      reject(
        new Error(
          `Unable to run ${command}. ${error.message}`,
        ),
      );
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(' ')} failed.${stderr ? `\n${stderr.trim()}` : ''}`,
        ),
      );
    });
  });

if (process.platform !== 'darwin') {
  console.error(
    'This icon generation script currently supports macOS only because it uses sips and iconutil.',
  );
  process.exit(1);
}

await access(sourcePath, constants.R_OK).catch(() => {
  throw new Error(`Source icon not found or unreadable: ${sourcePath}`);
});

await mkdir(outputDirectory, { recursive: true });
await rm(iconsetDirectory, { recursive: true, force: true });
await mkdir(iconsetDirectory, { recursive: true });
await cp(sourcePath, pngOutputPath);

for (const [fileName, size] of iconsetEntries) {
  await runCommand('sips', [
    '-z',
    String(size),
    String(size),
    sourcePath,
    '--out',
    path.join(iconsetDirectory, fileName),
  ]);
}

await runCommand('iconutil', [
  '-c',
  'icns',
  iconsetDirectory,
  '-o',
  icnsOutputPath,
]);

console.log(`Generated app icons from ${path.relative(projectRoot, sourcePath)}.`);
console.log(`- PNG: ${path.relative(projectRoot, pngOutputPath)}`);
console.log(`- ICNS: ${path.relative(projectRoot, icnsOutputPath)}`);
console.log('Restart the dev app or rebuild the packaged app to see the new icon.');
