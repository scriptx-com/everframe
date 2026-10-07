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
const artifacts = ['protocol', 'core', 'reporter-ui', 'media3', 'gradle-plugin'];
const version = '0.9.0';
const formerName = 'trace' + 'itx';
const formerGroup = `com.${formerName}`;
const formerEndpoint = `https://${formerName}.com`;
const coreClasses = {
  'dev/everframe/Everframe.class': 'https://everframe.dev dev.everframe Everframe',
  'dev/everframe/diagnostics/ReportDeliveryStatus.class': 'toJson',
  'dev/everframe/diagnostics/CaptureStatus.class': 'class',
  'dev/everframe/diagnostics/CapturePathStatus.class': 'class',
  'dev/everframe/diagnostics/QueueStatus.class': 'class',
  'dev/everframe/diagnostics/TransportStatus.class': 'class',
};

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
    if (artifact === 'gradle-plugin') {
      zip(`${prefix}.jar`, { 'dev/everframe/gradle/EverframePlugin.class': 'class' });
    } else if (artifact === 'reporter-ui') {
      const classes = `${prefix}-classes.jar`;
      zip(classes, { 'dev/everframe/ui/EFReporterFromImage.class': 'class' });
      zip(`${prefix}.aar`, {
        'AndroidManifest.xml': '<manifest package="dev.everframe" />',
        'classes.jar': readFileSync(classes),
      });
      rmSync(classes);
    } else if (artifact === 'core') {
      const classes = `${prefix}-classes.jar`;
      zip(classes, coreClasses);
      zip(`${prefix}.aar`, {
        'AndroidManifest.xml': '<manifest package="dev.everframe" />',
        'classes.jar': readFileSync(classes),
      });
      rmSync(classes);
    } else {
      zip(`${prefix}.aar`, {
        'AndroidManifest.xml': '<manifest package="dev.everframe" />',
        'classes.jar': 'dev.everframe Everframe',
      });
    }
    if (['core', 'reporter-ui', 'media3'].includes(artifact)) {
      writeFileSync(`${prefix}-mapping.txt`, '# compiler: R8\n# {"id":"sourceFile","fileName":"Source.kt"}\n');
    }
  }
  const markerDirectory = path.join(repository, 'dev/everframe/dev.everframe.gradle.plugin', version);
  mkdirSync(markerDirectory, { recursive: true });
  writeFileSync(path.join(markerDirectory, `dev.everframe.gradle.plugin-${version}.pom`),
    `<project><groupId>dev.everframe</groupId><artifactId>dev.everframe.gradle.plugin</artifactId><version>${version}</version><dependencies><dependency><groupId>dev.everframe</groupId><artifactId>gradle-plugin</artifactId><version>${version}</version></dependency></dependencies></project>`);
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

test('rejects a plugin marker that still points at the old implementation artifact', () => {
  const repository = fixture();
  try {
    const marker = path.join(repository, 'dev/everframe/dev.everframe.gradle.plugin', version,
      `dev.everframe.gradle.plugin-${version}.pom`);
    writeFileSync(marker, readFileSync(marker, 'utf8').replace('<artifactId>gradle-plugin</artifactId>',
      '<artifactId>everframe-gradle-plugin</artifactId>'));
    const result = verify(repository);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /does not point to the gradle-plugin artifact/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('rejects a minified Android artifact without its retrace mapping', () => {
  const repository = fixture();
  try {
    const mapping = path.join(repository, 'dev/everframe/core', version, `core-${version}-mapping.txt`);
    rmSync(mapping);
    const result = verify(repository);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /missing .*core-.*-mapping\.txt/);
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

test('rejects a release reporter AAR missing the host-image entry point', () => {
  const repository = fixture();
  try {
    const prefix = path.join(repository, 'dev/everframe/reporter-ui/0.9.0/reporter-ui-0.9.0');
    const classes = `${prefix}-classes.jar`;
    zip(classes, { 'dev/everframe/ui/TXReporterPresenter.class': 'class' });
    rmSync(`${prefix}.aar`);
    zip(`${prefix}.aar`, {
      'AndroidManifest.xml': '<manifest package="dev.everframe" />',
      'classes.jar': readFileSync(classes),
    });
    rmSync(classes);
    const result = verify(repository);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /EFReporterFromImage/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('rejects a release core AAR whose delivery diagnostics API was renamed or stripped', () => {
  const renamed = Object.fromEntries(Object.entries(coreClasses)
    .filter(([entry]) => !entry.endsWith('/ReportDeliveryStatus.class')));
  renamed['dev/everframe/diagnostics/p.class'] = 'class';
  const stripped = { ...coreClasses, 'dev/everframe/diagnostics/ReportDeliveryStatus.class': 'class' };
  for (const [classes, message] of [
    [renamed, /missing dev\.everframe\.diagnostics\.ReportDeliveryStatus/],
    [stripped, /ReportDeliveryStatus has no toJson/],
  ]) {
    const repository = fixture();
    try {
      const prefix = path.join(repository, 'dev/everframe/core/0.9.0/core-0.9.0');
      const jar = `${prefix}-classes.jar`;
      zip(jar, classes);
      rmSync(`${prefix}.aar`);
      zip(`${prefix}.aar`, {
        'AndroidManifest.xml': '<manifest package="dev.everframe" />',
        'classes.jar': readFileSync(jar),
      });
      rmSync(jar);
      const result = verify(repository);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, message);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  }
});
