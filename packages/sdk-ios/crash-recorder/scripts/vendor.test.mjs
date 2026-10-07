// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { prepareVendor, transform, vendorRoot } from './prepare-vendor.mjs';
import { verifyVendor } from './verify-vendor.mjs';
const upstreamRoot = process.env.KSCRASH_CHECKOUT;
const componentRoot = fileURLToPath(new URL('..', import.meta.url));
// Checks the deterministic preparation output and the packaged component source alike.
async function packaged(t, path) {
  const root = await fixture(t);
  return Promise.all([root, componentRoot].map(base => readFile(join(base, vendorRoot, path), 'utf8')));
}
assert.ok(upstreamRoot, 'KSCRASH_CHECKOUT must name the pinned upstream checkout');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'efcr-vendor-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await prepareVendor({ upstreamRoot, outputRoot: root });
  return root;
}
test('vendoring is deterministic, accurately licensed and injects every translation unit', async t => {
  const first = await fixture(t); const second = await fixture(t);
  const manifest = JSON.parse(await readFile(join(first, 'vendor-lock.json')));
  assert.equal(await readFile(join(first, 'vendor-lock.json'), 'utf8'), await readFile(join(second, 'vendor-lock.json'), 'utf8'));
  assert.equal(manifest.revision, '3f77f379c2db001e0c261c2a51b7e2b115d31f91');
  assert.equal(manifest.files.length, 197);
  for (const entry of manifest.files) {
    const content = await readFile(join(first, entry.path), 'utf8');
    if (/\.(c|m|cpp)$/.test(entry.path)) assert.match(content, /#include "EverframeKSCrashNamespace.h"/);
    if (entry.path.endsWith('/KSObjCApple.h')) assert.equal(entry.license, 'APSL-2.0');
    else if (entry.path.endsWith('/KSMach-O.c')) assert.equal(entry.license, 'MIT AND APSL-2.0');
    else if (entry.path.endsWith('/KSCxaThrowSwapper.c')) assert.equal(entry.license, 'MIT AND BSD-3-Clause');
    else assert.equal(entry.license, 'MIT');
    assert.match(entry.originalSha256, /^[a-f0-9]{64}$/);
  }
  await verifyVendor(first,{upstreamRoot});
});
test('rejects another revision before producing files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'efcr-wrong-rev-')); t.after(() => rm(root, { recursive:true,force:true }));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','fixture']);
  await assert.rejects(prepareVendor({ upstreamRoot:root, outputRoot:join(root,'output') }), /revision/);
});
for (const corruption of ['altered','missing','extra','manifest']) test(`rejects ${corruption} packaged source`, async t => {
  const root = await fixture(t); const manifest = JSON.parse(await readFile(join(root,'vendor-lock.json')));
  const path = join(root, manifest.files[0].path);
  if(corruption==='altered') await writeFile(path, 'altered');
  if(corruption==='missing') await rm(path);
  if(corruption==='extra') await writeFile(join(root,'Sources/EverframeCrashRecorder/Vendor/unexpected.c'), 'extra');
  if(corruption==='manifest') { manifest.revision='0'.repeat(40); await writeFile(join(root,'vendor-lock.json'),JSON.stringify(manifest)); }
  await assert.rejects(verifyVendor(root), /integrity|revision|file set/);
});
test('rejects locally modified upstream sources', async t => {
  const root = await mkdtemp(join(tmpdir(),'efcr-dirty-')); t.after(()=>rm(root,{recursive:true,force:true}));
  execFileSync('git',['-c','advice.detachedHead=false','clone','--quiet','--shared',upstreamRoot,root]);
  await writeFile(join(root,'Sources/KSCrashCore/include/KSCrashNamespace.h'),'changed');
  await assert.rejects(prepareVendor({upstreamRoot:root,outputRoot:join(root,'output')}),/modified/);
});
test('upstream verification rejects forged original provenance even with valid packaged hashes', async t => {
  const root=await fixture(t); const manifest=JSON.parse(await readFile(join(root,'vendor-lock.json')));
  manifest.files[0].originalSha256='0'.repeat(64);
  await writeFile(join(root,'vendor-lock.json'),JSON.stringify(manifest));
  await assert.rejects(verifyVendor(root,{upstreamRoot}),/provenance/);
});
test('merges all vendor privacy declarations into one component manifest', async t => {
  const root=await fixture(t);
  const path=join(root,'Sources/EverframeCrashRecorder/Resources/PrivacyInfo.xcprivacy');
  const manifest=JSON.parse(execFileSync('plutil',['-convert','json','-o','-',path],{encoding:'utf8'}));
  assert.equal(manifest.NSPrivacyTracking,false);
  assert.deepEqual(manifest.NSPrivacyTrackingDomains,[]);
  assert.deepEqual(manifest.NSPrivacyCollectedDataTypes.map(row=>row.NSPrivacyCollectedDataType).sort(),[
    'NSPrivacyCollectedDataTypeCrashData','NSPrivacyCollectedDataTypeDeviceID',
    'NSPrivacyCollectedDataTypeOtherDiagnosticData','NSPrivacyCollectedDataTypePerformanceData']);
  assert.deepEqual(manifest.NSPrivacyAccessedAPITypes,[{NSPrivacyAccessedAPIType:'NSPrivacyAccessedAPICategoryFileTimestamp',NSPrivacyAccessedAPITypeReasons:['C617.1']}]);
});
test('rejects altered component privacy declarations', async t => {
  const root=await fixture(t);
  await writeFile(join(root,'Sources/EverframeCrashRecorder/Resources/PrivacyInfo.xcprivacy'),'changed');
  await assert.rejects(verifyVendor(root),/resource integrity/);
});
test('resource monitor never changes the host battery monitoring setting', async t => {
  const path='KSCrashRecording/Monitors/KSCrashMonitor_Resource.m';
  for (const source of await packaged(t,path)) assert.doesNotMatch(source,/batteryMonitoringEnabled\s*=/);
  assert.throws(()=>transform(`Sources/${path}`,'unexpected'),/battery/);
});
test('reports copy no raw stack memory and keep registers for the crashed thread only', async t => {
  const path='KSCrashRecording/KSCrashReportC.c';
  for (const source of await packaged(t,path)) {
    assert.doesNotMatch(source,/stackBuffer|KSCrashField_Contents, \(void \*\)/);
    assert.match(source,/if \(isCrashedThread && ksmc_canHaveCPUState\(machineContext\)\) \{\n\s+writeRegisters\(/);
  }
  assert.throws(()=>transform(`Sources/${path}`,'unexpected'),/report memory/);
});
test('arm unwinding reports the restored caller instead of a stale link register', async t => {
  const path='KSCrashRecordingCore/Unwind/KSStackCursor_Unwind.c';
  for (const source of await packaged(t,path)) {
    assert.match(source,/const bool staleLR = frameRecordLiveAt\(crashPC\) &&/);
    assert.match(source,/\} else if \(staleLR &&[^{]+\{\n[^\n]+\n\s+nextAddress = ctx->pc;/);
  }
  assert.throws(()=>transform(`Sources/${path}`,'unexpected'),/link register/);
});
test('README names every vendored initializer that runs before main', async () => {
  const readme=await readFile(join(componentRoot,'README.md'),'utf8');
  const start=readme.indexOf('## Load-time behaviour');
  assert.ok(start>=0,'README has a load-time behaviour section');
  const section=readme.slice(start,readme.indexOf('\n## ',start+1)>0?readme.indexOf('\n## ',start+1):undefined);
  const manifest=JSON.parse(await readFile(join(componentRoot,'vendor-lock.json'),'utf8'));
  const initializers=[];
  for (const entry of manifest.files) {
    const source=await readFile(join(componentRoot,entry.path),'utf8');
    if (/^\+ ?\(void\) ?load\b|__attribute__\(\(constructor/m.test(source)) initializers.push(entry.path.slice(vendorRoot.length+1));
  }
  assert.deepEqual(initializers.sort(),['KSCrashRecording/KSCrashAppStateTracker.m','KSCrashRecordingCore/KSThreadInit.m']);
  assert.deepEqual(initializers.filter(path=>!section.includes(`\`${path}\``)),[]);
});
test('namespace prelude keeps the aliases that full-object linking requires', async () => {
  const prelude=await readFile(join(componentRoot,'Sources/EverframeCrashRecorder/EverframeKSCrashNamespace.h'),'utf8');
  assert.match(prelude,/^#define KSCRASH_NAMESPACE _everframe$/m);
  for (const name of ['kscrash_notifyObjCLoad','kscrash_notifyAppActive','kscrash_notifyAppInForeground',
    'kscrash_notifyAppTerminate','kscrash_notifyAppCrash','kscrash_testcode_setMonitors','kscrash_testcode_setLastRunID',
    'KSCrashReport','KSCrashMonitorPlugin','__cxa_throw']) {
    assert.match(prelude,new RegExp(`^#define ${name} KSCRASH_NS\\(${name}\\)$`,'m'),`missing private alias ${name}`);
  }
});
