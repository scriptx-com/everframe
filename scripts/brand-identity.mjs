// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const root = path.resolve(argument('--root', process.cwd()));
const policyPath = path.resolve(argument('--policy', path.join(root, 'brand-identity.json')));
const policyRelativePath = path.relative(root, policyPath).split(path.sep).join('/');
const former = 'trace' + 'itx';
const formerDisplay = 'Trace' + 'ItX';
const formerGenerated = 'Trace' + former.slice(5);
const formerUpper = former.toUpperCase();
const identityTail = '(?:[A-Za-z0-9_]|[.-](?=[A-Za-z0-9_]))*';
const packageTail = `[A-Za-z0-9_]${identityTail}`;
const identityPattern = new RegExp(
  `X-${formerDisplay}-[A-Za-z0-9_-]+|@${former}(?:/${packageTail})?|com\\.${former}(?:\\.[A-Za-z0-9_]+)*|${formerUpper}_[A-Za-z0-9_]*|${formerDisplay}${identityTail}|${formerGenerated}${identityTail}|${former}${identityTail}`,
  'g',
);
const diagnostics = [];
const diagnosticByKey = new Map();
const exceptions = new Map();
const exceptionsByFile = new Map();
const seen = new Set();

function report(file, match, reason, location = '') {
  const key = `${file}\0${match}\0${reason}`;
  const existing = diagnosticByKey.get(key);
  if (existing) {
    existing.count += 1;
    return;
  }
  const diagnostic = { file, location, match, reason, count: 1, order: diagnostics.length };
  diagnosticByKey.set(key, diagnostic);
  diagnostics.push(diagnostic);
}

function oldMatches(text) {
  return text.matchAll(identityPattern);
}

function validPattern(pattern) {
  if (typeof pattern !== 'string' || !pattern || /[\n\r*?\[\]{}()|^$\\]/.test(pattern)) return false;
  const normalized = pattern.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  if ([former, `com${former}`, `x${former}`].includes(normalized)) return false;
  const matches = [...oldMatches(pattern)];
  return matches.length === 1;
}

function allowed(file, source, match) {
  for (const entry of exceptionsByFile.get(file) ?? []) {
    let offset = source.indexOf(entry.pattern);
    while (offset !== -1) {
      if (match.index >= offset && match.index + match[0].length <= offset + entry.pattern.length) {
        seen.add(entry.key);
        return true;
      }
      offset = source.indexOf(entry.pattern, offset + 1);
    }
  }
  return false;
}

const tracked = spawnSync('git', ['-C', root, 'ls-files', '--cached', '-z'], { encoding: 'buffer' });
if (tracked.status !== 0) {
  process.stderr.write(`brand scan: cannot list tracked files: ${tracked.stderr.toString('utf8').trim()}\n`);
  process.exit(1);
}
const files = tracked.stdout.toString('utf8').split('\0').filter(Boolean).sort();
const fileSet = new Set(files);

let policy;
try {
  policy = JSON.parse(readFileSync(policyPath, 'utf8'));
} catch (error) {
  process.stderr.write(`brand scan: cannot read policy ${policyPath}: ${error.message}\n`);
  process.exit(1);
}
if (!policy || !Array.isArray(policy.exceptions)) {
  process.stderr.write(`brand scan: ${policyPath} must contain an exceptions array\n`);
  process.exit(1);
}

for (const [index, entry] of policy.exceptions.entries()) {
  const file = typeof entry?.path === 'string' ? entry.path : policyRelativePath;
  const pattern = entry?.pattern;
  const reason = entry?.reason;
  const key = `${file}\0${pattern}`;
  let valid = true;
  if (typeof entry?.path !== 'string' || !fileSet.has(file) || file === policyRelativePath || file.includes('\\')) {
    report(file, pattern ?? `exception ${index + 1}`, 'invalid exception path; use one exact tracked file');
    valid = false;
  }
  if (!validPattern(pattern)) {
    report(file, pattern ?? `exception ${index + 1}`, 'invalid exception pattern; use one exact old identity or contextual phrase');
    valid = false;
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    report(file, pattern ?? `exception ${index + 1}`, 'missing reason');
    valid = false;
  }
  if (exceptions.has(key)) {
    report(file, pattern, 'duplicate exception');
    valid = false;
  }
  if (valid) {
    exceptions.set(key, reason.trim());
    if (!exceptionsByFile.has(file)) exceptionsByFile.set(file, []);
    exceptionsByFile.get(file).push({ pattern, key });
  }
}

for (const file of files) {
  for (const match of oldMatches(file)) {
    if (!allowed(file, file, match)) report(file, match[0], 'active identity in path');
  }

  if (file === policyRelativePath) continue;
  const absolutePath = path.join(root, file);
  let buffer;
  try {
    if (!lstatSync(absolutePath).isFile()) continue;
    buffer = readFileSync(absolutePath);
  } catch (error) {
    report(file, file, `cannot read tracked file: ${error.message}`);
    continue;
  }
  if (buffer.includes(0)) continue;
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    continue;
  }

  let line = 1;
  let previous = 0;
  for (const match of oldMatches(content)) {
    for (let cursor = previous; cursor < match.index; cursor += 1) {
      if (content[cursor] === '\n') line += 1;
    }
    previous = match.index;
    if (!allowed(file, content, match)) {
      report(file, match[0], 'active identity in text', `:${line}:${match.index - content.lastIndexOf('\n', match.index - 1)}`);
    }
  }
}

for (const [key, reason] of exceptions) {
  if (seen.has(key)) continue;
  const [file, match] = key.split('\0');
  report(file, match, `stale exception; ${reason}`);
}

diagnostics.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.order - b.order);
if (diagnostics.length) {
  process.stderr.write(`${diagnostics.map((entry) =>
    `${entry.file}${entry.location}: ${JSON.stringify(entry.match)} — ${entry.reason}${entry.count > 1 ? ` (${entry.count} matches)` : ''}`
  ).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Brand identity OK (${files.length} tracked paths)\n`);
}
