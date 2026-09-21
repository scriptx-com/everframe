#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const values = new Map();
for (let index = 0; index < args.length; index += 2) {
  const key = args[index];
  const value = args[index + 1];
  if (!key?.startsWith('--') || value === undefined) {
    throw new Error(`invalid argument at position ${index + 1}`);
  }
  const entries = values.get(key) ?? [];
  entries.push(value);
  values.set(key, entries);
}

function one(name) {
  const entries = values.get(name) ?? [];
  if (entries.length > 1) throw new Error(`${name} may be specified only once`);
  return entries[0];
}

function javap(jar) {
  const result = spawnSync('javap', [
    '-classpath', jar,
    '-s', '-p',
    'com.traceitx.protocol.generated.Crash',
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`javap failed for ${jar}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function memberDescriptors(output) {
  const lines = output.split(/\r?\n/u);
  const descriptors = new Set();
  for (let index = 0; index < lines.length - 1; index++) {
    const declaration = lines[index].trim();
    const descriptorLine = lines[index + 1].trim();
    if (!/^(?:public|protected)\b/u.test(declaration) || !declaration.includes('(')
      || !descriptorLine.startsWith('descriptor: ')) continue;
    const beforeArguments = declaration.slice(0, declaration.indexOf('(')).trim();
    const declaredName = beforeArguments.split(/\s+/u).at(-1);
    const name = declaredName === 'com.traceitx.protocol.generated.Crash' ? '<init>' : declaredName;
    const descriptor = descriptorLine.slice('descriptor: '.length);
    // kotlinx.serialization changes this synthetic construction implementation
    // when an optional serial field is appended. Saved public callers use the
    // stable serializer()/write-self entry points, which are checked separately.
    if (descriptor.includes('SerializationConstructorMarker')) continue;
    descriptors.add(`${name} ${descriptor}`);
  }
  return descriptors;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function splitAssignment(value, label) {
  const separator = value.lastIndexOf('=');
  if (separator <= 0 || separator === value.length - 1) throw new Error(`invalid ${label}: ${value}`);
  return [value.slice(0, separator), value.slice(separator + 1)];
}

const baselineText = one('--baseline-javap')
  ? readFileSync(one('--baseline-javap'), 'utf8')
  : javap(one('--baseline-jar'));
const candidateJar = one('--candidate-jar');
const candidateText = one('--candidate-javap')
  ? readFileSync(one('--candidate-javap'), 'utf8')
  : javap(candidateJar);
const baselineDescriptors = memberDescriptors(baselineText);
const candidateDescriptors = memberDescriptors(candidateText);
const missing = [...baselineDescriptors].filter(member => !candidateDescriptors.has(member)).sort();
if (missing.length > 0) {
  throw new Error(`candidate lost supported Crash descriptors:\n${missing.join('\n')}`);
}

for (const requirement of values.get('--require-member') ?? []) {
  if (!candidateDescriptors.has(requirement)) {
    throw new Error(`candidate missing required new Crash descriptor: ${requirement}`);
  }
}

const callers = values.get('--caller') ?? [];
for (const caller of callers) {
  const [path, expected] = splitAssignment(caller, '--caller');
  const actual = sha256(path);
  if (actual !== expected) {
    throw new Error(`saved caller hash changed: ${path}\nexpected ${expected}\nactual   ${actual}`);
  }
}

const runs = values.get('--run') ?? [];
if (runs.length > 0 && !candidateJar) throw new Error('--run requires --candidate-jar');
const runtime = [candidateJar, ...(values.get('--runtime') ?? [])].join(delimiter);
for (const run of runs) {
  const [mainClass, expectedOutput] = splitAssignment(run, '--run');
  const result = spawnSync('java', ['-cp', runtime, mainClass], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`saved caller failed: ${mainClass}\n${result.stderr.trim()}`);
  }
  if (!result.stdout.includes(expectedOutput)) {
    throw new Error(`saved caller ${mainClass} did not print ${expectedOutput}`);
  }
}

console.log(`CRASH_MODEL_COMPAT_OK descriptors=${baselineDescriptors.size} callers=${callers.length} runs=${runs.length}`);
