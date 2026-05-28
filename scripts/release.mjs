#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rawArgs = process.argv.slice(2);
const flags = new Set(rawArgs.filter((value) => value.startsWith('--')));
const positionalArgs = rawArgs.filter((value) => !value.startsWith('--'));
const coreVersion = normalizeVersion(positionalArgs[0]);
const reactVersion = normalizeVersion(readFlagValue(rawArgs, '--react-version') ?? coreVersion);

if (!coreVersion) {
  printUsageAndExit();
}

if (!isVersionLike(coreVersion) || !isVersionLike(reactVersion)) {
  console.error('Version must look like 1.2.3 or 1.2.3-beta.1.');
  process.exit(1);
}

updateJson(resolve(rootDir, 'package.json'), (pkg) => {
  pkg.version = coreVersion;
});

updateJson(resolve(rootDir, 'packages/core/package.json'), (pkg) => {
  pkg.version = coreVersion;
  pkg.repository = {
    type: 'git',
    url: 'git+https://github.com/ARES-AM2003/Zip-it-package.git',
  };
});

updateJson(resolve(rootDir, 'packages/react/package.json'), (pkg) => {
  pkg.version = reactVersion;
  pkg.peerDependencies = {
    ...pkg.peerDependencies,
    '@blueneon/zip-it': `^${coreVersion}`,
  };
  pkg.devDependencies = {
    ...pkg.devDependencies,
    '@blueneon/zip-it': `^${coreVersion}`,
  };
});

updateJson(resolve(rootDir, 'apps/web/package.json'), (pkg) => {
  pkg.dependencies = {
    ...pkg.dependencies,
    '@blueneon/zip-it': `^${coreVersion}`,
  };
});

console.log(`Updated package versions: @blueneon/zip-it@${coreVersion}, @blueneon/zipit-react@${reactVersion}`);

execSync('npm run build', { cwd: rootDir, stdio: 'inherit' });
execSync('npm publish --workspace @blueneon/zip-it --access public', { cwd: rootDir, stdio: 'inherit' });
execSync('npm publish --workspace @blueneon/zipit-react --access public', { cwd: rootDir, stdio: 'inherit' });

function updateJson(filePath, updater) {
  const data = JSON.parse(readFileSync(filePath, 'utf8'));
  updater(data);
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function readFlagValue(args, flagName) {
  const index = args.indexOf(flagName);
  if (index === -1) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    console.error(`Missing value for ${flagName}.`);
    process.exit(1);
  }

  return value;
}

function normalizeVersion(version) {
  if (!version) {
    return undefined;
  }

  return version.startsWith('v') ? version.slice(1) : version;
}

function isVersionLike(version) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);
}

function printUsageAndExit() {
  console.error('Usage: npm run release -- <core-version> [--react-version <version>]');
  console.error('Example: npm run release -- 2.0.2');
  console.error('Example: npm run release -- 2.0.2 --react-version 0.1.2');
  process.exit(1);
}