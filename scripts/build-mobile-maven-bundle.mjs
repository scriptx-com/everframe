// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const android = path.join(root, 'packages/sdk-android/android');
const kmp = path.join(root, 'packages/everframe_kmp');
const prepareOnly = process.argv.includes('--prepare');
if (process.argv.length > (prepareOnly ? 3 : 2)) {
  throw new Error('Usage: node scripts/build-mobile-maven-bundle.mjs [--prepare]');
}

const versionLine = readFileSync(path.join(android, 'gradle.properties'), 'utf8')
  .match(/^everframeVersion=(\d+\.\d+\.\d+)$/m);
assert.ok(versionLine, 'Android gradle.properties must declare the mobile release version');
const version = versionLine[1];

if (!prepareOnly && (!process.env.SIGNING_KEY || !process.env.SIGNING_PASSWORD)) {
  throw new Error('A publishable bundle requires SIGNING_KEY and SIGNING_PASSWORD. Use --prepare to inspect an unsigned bundle.');
}

function run(program, args, options = {}) {
  execFileSync(program, args, { stdio: 'inherit', ...options });
}

run(path.join(android, 'gradlew'), ['centralPortalBundle'], { cwd: android });
const androidRepository = path.join(android, 'build/central-bundle/repository');
run(path.join(kmp, 'gradlew'), ['centralPortalBundle'], {
  cwd: kmp,
  env: { ...process.env, MAVEN_LOCAL_REPOSITORY: androidRepository },
});
const kmpRepository = path.join(kmp, 'build/central-bundle/repository');

const releaseRoot = path.join(root, 'build/mobile-bundles');
mkdirSync(releaseRoot, { recursive: true });
const work = mkdtempSync(path.join(releaseRoot, `${version}-`));
const repository = path.join(work, 'repository');
const group = path.join(repository, 'dev/everframe');
mkdirSync(group, { recursive: true });

for (const sourceRepository of [androidRepository, kmpRepository]) {
  const sourceGroup = path.join(sourceRepository, 'dev/everframe');
  for (const artifact of readdirSync(sourceGroup)) {
    const target = path.join(group, artifact);
    assert.ok(!existsSync(target), `Duplicate artifact in mobile bundle: ${artifact}`);
    cpSync(path.join(sourceGroup, artifact), target, { recursive: true });
  }
}

const artifacts = [
  'protocol', 'core', 'reporter-ui', 'media3', 'gradle-plugin',
  'dev.everframe.gradle.plugin',
  'kmp', 'kmp-android', 'kmp-iosarm64', 'kmp-iossimulatorarm64', 'kmp-jvm',
];
assert.deepEqual(readdirSync(group).sort(), artifacts.slice().sort(), 'Mobile bundle has unexpected Maven artifacts');

for (const artifact of artifacts) {
  const prefix = path.join(group, artifact, version, `${artifact}-${version}`);
  const pom = readFileSync(`${prefix}.pom`, 'utf8');
  assert.match(pom, /<groupId>dev\.everframe<\/groupId>/);
  assert.ok(pom.includes(`<artifactId>${artifact}</artifactId>`), `${artifact} POM has the wrong artifact ID`);
  assert.ok(pom.includes(`<version>${version}</version>`), `${artifact} POM has the wrong version`);
}

const marker = readFileSync(path.join(group, 'dev.everframe.gradle.plugin', version,
  `dev.everframe.gradle.plugin-${version}.pom`), 'utf8');
assert.ok(marker.includes('<artifactId>gradle-plugin</artifactId>'), 'Gradle plugin marker has the wrong implementation');

const kmpMetadata = readFileSync(path.join(group, 'kmp', version, `kmp-${version}.module`), 'utf8');
for (const target of ['android', 'iosarm64', 'iossimulatorarm64', 'jvm']) {
  assert.ok(kmpMetadata.includes(`"module": "kmp-${target}"`), `KMP metadata omits ${target}`);
}
const kmpAndroidPom = readFileSync(path.join(group, 'kmp-android', version,
  `kmp-android-${version}.pom`), 'utf8');
for (const nativeArtifact of ['core', 'reporter-ui']) {
  assert.ok(kmpAndroidPom.includes(`<artifactId>${nativeArtifact}</artifactId>\n      <version>${version}</version>`),
    `KMP Android must depend on ${nativeArtifact} ${version}`);
}

run(path.join(root, 'scripts/verify-android-publication.sh'), [version], {
  env: { ...process.env, MAVEN_LOCAL_REPOSITORY: repository },
});
if (!prepareOnly) {
  run(path.join(root, 'scripts/verify-central-bundle.sh'), [repository, version], {
    env: { ...process.env, EVERFRAME_VERIFY_GPG: '1' },
  });
}

const bundle = path.join(work, `everframe-mobile-${version}.zip`);
run('zip', ['-q', '-r', bundle, 'dev'], { cwd: repository });
console.log(`${prepareOnly ? 'Unsigned preparation bundle' : 'Signed release bundle'}: ${bundle}`);
if (prepareOnly) console.log('The unsigned preparation bundle cannot be uploaded to Maven Central.');
