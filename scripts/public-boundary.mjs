// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const root = path.resolve(argument('--root', process.cwd()));
const policyPath = path.resolve(argument('--policy', path.join(root, 'public-boundary.json')));
const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
const diagnostics = [];
const spdxLabel = `SPDX-${'License-Identifier:'}`;

function report(relativePath, message) {
  diagnostics.push(`${relativePath}: ${message}`);
}

function walk(directory, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
    if (path.resolve(absolutePath) === policyPath) continue;
    if (matchesAny(relativePath, policy.ignoredPathPatterns)) continue;
    if (entry.isSymbolicLink()) {
      report(relativePath, 'symbolic links are not allowed in the public source tree');
      continue;
    }
    if (entry.isDirectory()) walk(absolutePath, output);
    else if (entry.isFile()) output.push({ absolutePath, relativePath });
  }
  return output;
}

for (const requiredPath of policy.requiredPaths ?? []) {
  if (!existsSync(path.join(root, requiredPath))) {
    report(requiredPath, 'required path is missing');
  }
}

function isProbablyText(buffer) {
  return !buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
}

function matchesAny(value, patterns = []) {
  return patterns.some((pattern) => new RegExp(pattern).test(value));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const files = walk(root).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
const allowedTopLevel = new Set(policy.allowedTopLevel ?? []);
const publicPackages = new Set(policy.publicPackages ?? []);
const internalDependencies = [];
const publicPackageScope = '@everframe/';
const legacyPackageScope = '@traceitx/';

for (const file of files) {
  const { absolutePath, relativePath } = file;
  const topLevel = relativePath.split('/')[0];
  if (allowedTopLevel.size > 0 && !allowedTopLevel.has(topLevel)) {
    report(relativePath, `top-level path ${topLevel} is not in allowedTopLevel`);
  }
  if (matchesAny(relativePath, policy.forbiddenPathPatterns)) {
    report(relativePath, 'forbidden path');
  }

  const buffer = readFileSync(absolutePath);
  if (!isProbablyText(buffer)) continue;
  const text = buffer.toString('utf8');

  for (const rule of policy.forbiddenTextPatterns ?? []) {
    if (new RegExp(rule.pattern, rule.flags ?? '').test(text)) {
      report(relativePath, rule.reason ?? `forbidden text matching ${rule.pattern}`);
    }
  }

  if ((policy.envTemplates ?? []).includes(relativePath)) {
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match && match[2] !== '') {
        report(`${relativePath}:${index + 1}`, `${match[1]} must be empty in a public environment template`);
      }
    }
  }

  if (path.basename(relativePath) === 'package.json') {
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch (error) {
      report(relativePath, `invalid package manifest: ${error.message}`);
      continue;
    }
    if (relativePath.startsWith('packages/')) {
      if (manifest.name?.startsWith(legacyPackageScope)) {
        report(relativePath, `${manifest.name} uses the legacy package scope`);
      } else if (manifest.name?.startsWith(publicPackageScope) && !publicPackages.has(manifest.name)) {
        report(relativePath, `${manifest.name} is not in publicPackages`);
      }
    }
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [name, version] of Object.entries(manifest[section] ?? {})) {
        if (name.startsWith(publicPackageScope) || name.startsWith(legacyPackageScope)) {
          internalDependencies.push({ relativePath, name, version });
        }
      }
    }
  }

  const extension = path.extname(relativePath);
  const upstream = (policy.license?.upstream ?? []).find((entry) =>
    entry.path === relativePath || (entry.pathPattern && new RegExp(entry.pathPattern).test(relativePath))
  );
  if (upstream || (policy.license?.ownedExtensions ?? []).includes(extension)) {
    const exempt = matchesAny(relativePath, policy.license?.exemptPathPatterns);
    if (!exempt) {
      const required = upstream?.spdx ?? 'MIT';
      const header = text.split(/\r?\n/).slice(0, 30).join('\n');
      const declaration = new RegExp(
        `(^|\\n)\\s*(?://|#|/\\*|<!--|@rem)\\s*${escapeRegExp(spdxLabel)}\\s+${escapeRegExp(required)}(?:\\s|-->|\\*/|$)`,
        'i',
      );
      if (!declaration.test(header)) {
        report(relativePath, `header missing ${spdxLabel} ${required}`);
      }
    }
  }
}

for (const dependency of internalDependencies) {
  if (dependency.name.startsWith(legacyPackageScope)) {
    report(dependency.relativePath, `${dependency.name} uses the legacy package scope`);
  } else if (!publicPackages.has(dependency.name)) {
    report(dependency.relativePath, `${dependency.name} is not in publicPackages`);
  }
}

diagnostics.sort((a, b) => a.localeCompare(b));
if (diagnostics.length > 0) {
  process.stderr.write(`${diagnostics.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Public boundary OK (${files.length} files)\n`);
}
