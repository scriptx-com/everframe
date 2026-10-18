// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const read = (file) => readFileSync(file, 'utf8');
const manifest = (dir) => JSON.parse(read(`packages/${dir}/package.json`));

// Every published npm package; the release groups below say which ones release together.
const published = {
  '@everframe/web': 'sdk-web',
  '@everframe/react': 'sdk-react',
  '@everframe/react-native': 'sdk-react-native',
  '@everframe/identity': 'identity',
  '@everframe/roku': 'sdk-roku',
  '@everframe/vega': 'sdk-vega',
  '@everframe/cli': 'cli',
  '@everframe/metro': 'metro',
  '@everframe/bundler-plugin': 'bundler-plugin',
  '@everframe/expo': 'expo',
};

// Packages that release together, one changesets `fixed` group each. Inside a group every
// manifest shares one version; across groups they may differ, because the release tool
// (`pnpm publish:all --groups …` in the private repo) can release a group on its own. The
// native SDKs and both bridges are `mobile`: they pin each other by derived ranges.
const groups = {
  mobile: ['@everframe/react-native', '@everframe/sdk-android', '@everframe/sdk-ios-marker'],
  web: ['@everframe/web', '@everframe/react', '@everframe/identity'],
  tv: ['@everframe/roku', '@everframe/vega'],
  tools: ['@everframe/cli', '@everframe/metro', '@everframe/bundler-plugin', '@everframe/expo'],
};

// Private workspace markers whose CHANGELOGs record the native Android and iOS releases.
const nativeMarkers = {
  '@everframe/sdk-android': 'sdk-android',
  '@everframe/sdk-ios-marker': 'sdk-ios',
};

const dirOf = (name) => published[name] ?? nativeMarkers[name];
const groupOf = (name) => Object.keys(groups).find((g) => groups[g].includes(name));
/** Each group's version, read from its first member. */
const currentVersions = (readFile = read) =>
  Object.fromEntries(
    Object.entries(groups).map(([g, [first]]) => [
      g,
      JSON.parse(readFile(`packages/${dirOf(first)}/package.json`)).version,
    ]),
  );

// Every file that carries a release version, and what it must contain for each group's
// `versions`. All expectations derive from the versions, so a patch release (native SDK and
// bridges on x.y.z), a minor release and a single-group release pass the same checks.
function versionAlignmentProblems(versions, readFile) {
  const { mobile, web, tv } = versions;
  const [major, minor] = mobile.split('.').map(Number);
  const nativeRange = `[${mobile},${major}.${minor + 1}.0)`;
  const problems = [];
  const expect = (file, needle) => {
    const text = readFile(file);
    const ok = needle instanceof RegExp ? needle.test(text) : text.includes(needle);
    if (!ok) problems.push(`${file}: expected ${needle}`);
  };
  for (const [g, names] of Object.entries(groups)) {
    for (const name of names) {
      const dir = dirOf(name);
      const pkg = JSON.parse(readFile(`packages/${dir}/package.json`));
      if (pkg.version !== versions[g])
        problems.push(
          `packages/${dir}/package.json: version ${pkg.version}, ${g} is ${versions[g]}`,
        );
    }
  }
  // `prebuild` rewrites these from package.json. A stale committed literal makes every build
  // dirty the tree, which blocks the next production deploy's fast-forward of the SDK checkout.
  for (const dir of ['sdk-web', 'sdk-react'])
    expect(`packages/${dir}/src/internal/version.ts`, `PKG_VERSION = '${web}';`);
  expect('packages/sdk-roku/library/components/Everframe/lib/ef_version.brs', `return "${tv}"`);
  const [tvMajor, tvMinor, tvPatch] = tv.split('.').map(Number);
  for (const line of [
    `major_version=${tvMajor}`,
    `minor_version=${tvMinor}`,
    `build_version=${tvPatch}`,
  ]) {
    expect('packages/sdk-roku/library/manifest', new RegExp(`^${line}$`, 'm'));
  }
  const version = mobile;
  expect('packages/everframe_flutter/pubspec.yaml', `version: ${version}\n`);
  expect('packages/everframe_flutter/lib/src/web_sdk_web.dart', `sdkVersion: '${version}'.toJS`);
  expect('packages/everframe_flutter/android/build.gradle.kts', `version = "${version}"`);
  expect('packages/everframe_flutter/ios/everframe_flutter.podspec', `s.version = '${version}'`);
  expect('packages/sdk-android/android/gradle.properties', `everframeVersion=${version}\n`);
  expect(
    'packages/sdk-ios/Everframe.podspec',
    new RegExp(`^\\s*spec\\.version\\s*=\\s*"${version.replaceAll('.', '\\.')}"`, 'm'),
  );
  for (const file of ['packages/sdk-ios/Package.binary.swift', 'Package.swift'])
    expect(file, `let binaryVersion = "${version}"`);
  // The bridges accept native patches within the release's minor line, from this release on.
  for (const file of [
    'packages/everframe_flutter/android/build.gradle.kts',
    'packages/sdk-react-native/android/build.gradle.kts',
  ]) {
    expect(file, nativeRange);
  }
  expect(
    'packages/everframe_flutter/ios/everframe_flutter.podspec',
    `'Everframe/Core', '~> ${version}'`,
  );
  expect(
    'packages/everframe_flutter/ios/everframe_flutter.podspec',
    `'Everframe/ReporterUI', '~> ${version}'`,
  );
  expect('packages/sdk-react-native/EverframeRN.podspec', `'~> ${version}'`);
  expect(
    'packages/everframe_flutter/ios/everframe_flutter/Package.swift',
    `.upToNextMinor(from: "${version}")`,
  );
  return problems;
}

// The group a version-bearing file belongs to: a package.json by its package, the browser
// SDKs' version files to `web`, Roku's to `tv`, and every native and bridge file to `mobile`.
function fileGroup(file) {
  if (file.endsWith('package.json')) return groupOf(JSON.parse(read(file)).name);
  if (/^packages\/sdk-(web|react)\//.test(file)) return 'web';
  if (file.startsWith('packages/sdk-roku/')) return 'tv';
  return 'mobile';
}

// What a release bump does to the version-bearing files of the `bumped` groups: every literal of
// the old version becomes the new one, the bridges' native range moves its upper bound for a
// minor release, and the Roku manifest takes the new components. Other groups' files are left
// exactly as they are.
function bumpedReader(from, to, bumped = Object.keys(groups)) {
  const [fromMajor, fromMinor] = from.split('.').map(Number);
  const [toMajor, toMinor, toPatch] = to.split('.').map(Number);
  return (file) => {
    let text = read(file);
    if (!bumped.includes(fileGroup(file))) return text;
    if (file.endsWith('package.json')) return JSON.stringify({ ...JSON.parse(text), version: to });
    text = text
      .replaceAll(`,${fromMajor}.${fromMinor + 1}.0)`, `,${toMajor}.${toMinor + 1}.0)`)
      .replaceAll(from, to);
    if (file === 'packages/sdk-roku/library/manifest') {
      text = text
        .replace(/^major_version=.*$/m, `major_version=${toMajor}`)
        .replace(/^minor_version=.*$/m, `minor_version=${toMinor}`)
        .replace(/^build_version=.*$/m, `build_version=${toPatch}`);
    }
    return text;
  };
}

test('the changeset fixed groups are the four release groups', () => {
  const { fixed } = JSON.parse(read('.changeset/config.json'));
  const sorted = (list) => [...list].sort();
  assert.deepEqual(fixed.map(sorted), Object.values(groups).map(sorted));
  assert.deepEqual(
    sorted(Object.values(groups).flat()),
    sorted([...Object.keys(published), ...Object.keys(nativeMarkers)]),
  );
});

test('the native markers carry the mobile version, so their CHANGELOGs share its heading', () => {
  const versions = currentVersions();
  for (const [name, dir] of Object.entries(nativeMarkers)) {
    const pkg = manifest(dir);
    assert.equal(pkg.name, name, dir);
    assert.equal(pkg.version, versions.mobile, dir);
    assert.equal(pkg.private, true, dir);
  }
});

test("every published npm package is publishable at its group's version", () => {
  const versions = currentVersions();
  for (const [name, dir] of Object.entries(published)) {
    const pkg = manifest(dir);
    assert.equal(pkg.name, name, dir);
    assert.equal(pkg.version, versions[groupOf(name)], dir);
    assert.notEqual(pkg.private, true, dir);
    assert.equal(pkg.publishConfig?.access, 'public', dir);
  }
});

test('no other workspace package is published', () => {
  const dirs = readdirSync('packages', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const dir of dirs) {
    if (!existsSync(`packages/${dir}/package.json`)) continue;
    const pkg = manifest(dir);
    if (pkg.private !== true)
      assert.ok(pkg.name in published, `${pkg.name} is publishable but not on the release line`);
  }
});

test('internal dependencies between published packages follow the workspace version', () => {
  for (const dir of Object.values(published)) {
    const pkg = manifest(dir);
    for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.peerDependencies })) {
      if (name in published) assert.equal(range, 'workspace:^', `${dir} -> ${name}`);
    }
  }
});

const every = (version) => Object.fromEntries(Object.keys(groups).map((g) => [g, version]));

test('every file that carries a release version matches its group', () => {
  assert.deepEqual(versionAlignmentProblems(currentVersions(), read), []);
});

// The bump tests start from a tree whose groups agree, which is what a full release produces.
const sharedVersion = () => {
  const versions = [...new Set(Object.values(currentVersions()))];
  return versions.length === 1 ? versions[0] : null;
};

test('the alignment checks hold for a patch release where native and bridges share the patch', (t) => {
  const from = sharedVersion();
  if (!from) return t.skip('groups are on different versions');
  const [major, minor, patch] = from.split('.').map(Number);
  const next = `${major}.${minor}.${patch + 1}`;
  assert.deepEqual(versionAlignmentProblems(every(next), bumpedReader(from, next)), []);
  // A bridge left on the previous release's floor fails the patch check.
  const stale = bumpedReader(from, next);
  const staleRange = (file) =>
    file === 'packages/sdk-react-native/android/build.gradle.kts' ? read(file) : stale(file);
  assert.equal(versionAlignmentProblems(every(next), staleRange).length, 1);
});

test('the alignment checks hold for a minor release', (t) => {
  const from = sharedVersion();
  if (!from) return t.skip('groups are on different versions');
  const [major, minor] = from.split('.').map(Number);
  const next = `${major}.${minor + 1}.0`;
  assert.deepEqual(versionAlignmentProblems(every(next), bumpedReader(from, next)), []);
});

test('a tools-only bump leaves the other groups aligned', (t) => {
  const from = sharedVersion();
  if (!from) return t.skip('groups are on different versions');
  const [major, minor, patch] = from.split('.').map(Number);
  const next = `${major}.${minor}.${patch + 1}`;
  const versions = { ...every(from), tools: next };
  assert.deepEqual(versionAlignmentProblems(versions, bumpedReader(from, next, ['tools'])), []);
  // Bumping the tools without saying so is caught on each of the four tools manifests.
  assert.equal(
    versionAlignmentProblems(every(from), bumpedReader(from, next, ['tools'])).length,
    groups.tools.length,
  );
});

test('Gradle coordinates the release depends on', () => {
  assert.match(read('packages/everframe_kmp/build.gradle.kts'), /version = mobileReleaseVersion/);
  assert.match(read('packages/everframe_kmp/build.gradle.kts'), /\.orElse\(mobileReleaseVersion\)/);
  assert.match(read('packages/everframe_kmp/settings.gradle.kts'), /^rootProject\.name = "kmp"$/m);
  assert.match(
    read('packages/sdk-android/android/everframe-gradle-plugin/build.gradle.kts'),
    /artifactId = "gradle-plugin"/,
  );
});
