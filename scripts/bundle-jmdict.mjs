import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const outputDirectory = path.join(projectRoot, 'assets', 'jmdict');
const bundledJsonPath = path.join(outputDirectory, 'jmdict-eng.json');
const metadataPath = path.join(outputDirectory, 'metadata.json');
const latestReleaseApi =
  'https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest';

const parseArgs = (argv) => {
  const options = {
    source: 'latest',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case '--source':
      case '--url':
        options.source = argv[index + 1];
        index += 1;
        break;
      case '--help':
      case '-h':
        console.log('Usage: npm run bundle -- [--source <latest|url|path>]');
        process.exit(0);
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown option: ${arg}`);
        }

        options.source = arg;
        break;
    }
  }

  return options;
};

const isUrl = (value) => /^https?:\/\//i.test(value);

const resolveLatestAsset = async () => {
  const response = await fetch(latestReleaseApi, {
    headers: {
      'User-Agent': 'language-jmdict-bundler',
      Accept: 'application/vnd.github+json',
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to resolve latest JMDict-Simplified release: ${response.status} ${response.statusText}`,
    );
  }

  const release = await response.json();
  const asset = release.assets.find((candidate) =>
    /^jmdict-eng-.*\.json\.tgz$/.test(candidate.name),
  );

  if (!asset?.browser_download_url) {
    throw new Error('Could not find a jmdict-eng JSON archive in the latest release');
  }

  return {
    sourceUrl: asset.browser_download_url,
    releaseTag: release.tag_name ?? null,
    assetName: asset.name,
  };
};

const downloadFile = async (sourceUrl, destinationPath) => {
  const response = await fetch(sourceUrl, {
    headers: {
      'User-Agent': 'language-jmdict-bundler',
      Accept: 'application/octet-stream',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download ${sourceUrl}: ${response.status} ${response.statusText}`);
  }

  writeFileSync(destinationPath, Buffer.from(await response.arrayBuffer()));
};

const extractArchive = async (archivePath, directoryPath) => {
  for (const fileName of readdirSync(directoryPath)) {
    if (/^jmdict-eng-.*\.json$/.test(fileName)) {
      rmSync(path.join(directoryPath, fileName), { force: true });
    }
  }

  await tar.x({
    file: archivePath,
    cwd: directoryPath,
  });

  const extractedFileName = readdirSync(directoryPath).find((fileName) =>
    /^jmdict-eng-.*\.json$/.test(fileName),
  );

  if (!extractedFileName) {
    throw new Error(`Expected extracted file was not found in ${directoryPath}`);
  }

  const extractedPath = path.join(directoryPath, extractedFileName);

  if (!existsSync(extractedPath)) {
    throw new Error(`Expected extracted file was not found: ${extractedPath}`);
  }

  return extractedPath;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(outputDirectory, { recursive: true });

  const archivePath = path.join(outputDirectory, 'jmdict-eng.json.tgz');
  let sourceLabel = options.source;
  let releaseTag = null;
  let assetName = null;

  if (options.source === 'latest') {
    const latestAsset = await resolveLatestAsset();
    sourceLabel = latestAsset.sourceUrl;
    releaseTag = latestAsset.releaseTag;
    assetName = latestAsset.assetName;
    console.log(`Downloading ${latestAsset.assetName} from ${latestAsset.sourceUrl}`);
    await downloadFile(latestAsset.sourceUrl, archivePath);
  } else if (isUrl(options.source)) {
    console.log(`Downloading ${options.source}`);
    assetName = path.basename(new URL(options.source).pathname);
    await downloadFile(options.source, archivePath);
  } else {
    const localSourcePath = path.resolve(projectRoot, options.source);

    if (localSourcePath.endsWith('.json')) {
      copyFileSync(localSourcePath, bundledJsonPath);
      writeFileSync(
        metadataPath,
        JSON.stringify(
          {
            downloadedAt: new Date().toISOString(),
            source: localSourcePath,
            assetName: path.basename(localSourcePath),
            releaseTag: null,
          },
          null,
          2,
        ),
      );
      console.log(`Bundled JMdict JSON saved to ${bundledJsonPath}`);
      return;
    }

    sourceLabel = localSourcePath;
    assetName = path.basename(localSourcePath);
    copyFileSync(localSourcePath, archivePath);
  }

  if (!assetName) {
    throw new Error('Could not determine the bundled JMDict archive name');
  }

  const extractedPath = await extractArchive(archivePath, outputDirectory);
  rmSync(bundledJsonPath, { force: true });
  renameSync(extractedPath, bundledJsonPath);
  rmSync(archivePath, { force: true });

  writeFileSync(
    metadataPath,
    JSON.stringify(
      {
        downloadedAt: new Date().toISOString(),
        source: sourceLabel,
        assetName,
        releaseTag,
      },
      null,
      2,
    ),
  );

  console.log(`Bundled JMdict JSON saved to ${bundledJsonPath}`);
  console.log('The Electron main process will build a local jmdict-simplified-node cache on first launch.');
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
