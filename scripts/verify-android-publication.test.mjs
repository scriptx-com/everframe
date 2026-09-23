// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const verifier = path.join(root, 'scripts/verify-android-publication.sh');
const artifacts = ['protocol', 'core', 'reporter-ui', 'media3', 'everframe-gradle-plugin'];
const version = '0.9.0';
const formerName = 'trace' + 'itx';
const formerGroup = `com.${formerName}`;
const formerEndpoint = `https://${formerName}.com`;

function zip(destination, entries) {
  const source = mkdtempSync(path.join(tmpdir(), 'everframe-zip-'));
  try {
    for (const [entry, contents] of Object.entries(entries)) {
      const target = path.join(source, entry);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }
    const result = spawnSync('zip', ['-q', '-r', destination, '.'], { cwd: source, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
}

function fixture() {
  const repository = mkdtempSync(path.join(tmpdir(), 'everframe-maven-'));
  for (const artifact of artifacts) {
    const directory = path.join(repository, 'dev/everframe', artifact, version);
    mkdirSync(directory, { recursive: true });
    const prefix = path.join(directory, `${artifact}-${version}`);
    writeFileSync(`${prefix}.pom`, `<?xml version="1.0"?><project><groupId>dev.everframe</groupId><artifactId>${artifact}</artifactId><version>${version}</version><dependencies><dependency><groupId>dev.everframe</groupId><artifactId>protocol</artifactId><version>${version}</version></dependency></dependencies></project>`);
    zip(`${prefix}-sources.jar`, { [`dev/everframe/${artifact.replaceAll('-', '')}/Source.kt`]: 'package dev.everframe' });
    zip(`${prefix}-javadoc.jar`, { 'index.html': '<html>Everframe</html>' });
    if (artifact === 'everframe-gradle-plugin') {
      zip(`${prefix}.jar`, { 'dev/everframe/gradle/EverframePlugin.class': 'class' });
    } else {
      zip(`${prefix}.aar`, {
        'AndroidManifest.xml': '<manifest package="dev.everframe" />',
        'classes.jar': artifact === 'core' ? 'https://everframe.dev dev.everframe Everframe' : 'dev.everframe Everframe',
      });
    }
  }
  return repository;
}

function verify(repository) {
  return spawnSync('bash', [verifier, version], {
    cwd: root,
    env: { ...process.env, MAVEN_LOCAL_REPOSITORY: repository },
    encoding: 'utf8',
  });
}

test('accepts the canonical dev.everframe publication tree', () => {
  const repository = fixture();
  try {
    const result = verify(repository);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('rejects legacy Maven dependencies in published POMs', () => {
  const repository = fixture();
  try {
    const pom = path.join(repository, 'dev/everframe/core/0.9.0/core-0.9.0.pom');
    writeFileSync(pom, readFileSync(pom, 'utf8').replaceAll('dev.everframe', formerGroup));
    const result = verify(repository);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /former Maven|does not use dev\.everframe/i);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('rejects a release core AAR containing the legacy endpoint', () => {
  const repository = fixture();
  try {
    const aar = path.join(repository, 'dev/everframe/core/0.9.0/core-0.9.0.aar');
    rmSync(aar);
    zip(aar, { 'AndroidManifest.xml': '<manifest package="dev.everframe" />', 'classes.jar': formerEndpoint });
    const result = verify(repository);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /former endpoint|does not contain the Everframe release endpoint/i);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
