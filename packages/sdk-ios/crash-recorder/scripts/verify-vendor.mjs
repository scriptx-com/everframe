// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { revision, vendorRoot, sha256, licenseFor, transform, sourceRoots } from './prepare-vendor.mjs';
async function paths(root,relative) {
  const entries=await readdir(join(root,relative),{withFileTypes:true});
  return (await Promise.all(entries.map(entry=> {
    const path=`${relative}/${entry.name}`;
    if(entry.isDirectory()) return paths(root,path);
    if(!entry.isFile()) throw new Error(`integrity: unexpected non-file ${path}`);
    return [path];
  }))).flat().sort();
}
export async function verifyVendor(root, {upstreamRoot} = {}) {
  const manifest=JSON.parse(await readFile(join(root,'vendor-lock.json'),'utf8'));
  if(manifest.schemaVersion!==1 || manifest.revision!==revision || manifest.version!=='2.6.0') throw new Error('revision integrity mismatch');
  const git = args => execFileSync('git',['-C',upstreamRoot,...args],{encoding:'utf8'}).trim();
  if(upstreamRoot && (git(['rev-parse','HEAD'])!==revision || git(['status','--porcelain','--',...sourceRoots.map(p=>`Sources/${p}`)]))) throw new Error('upstream provenance mismatch');
  if(upstreamRoot) {
    const originals=git(['ls-tree','-r','--name-only','HEAD','--',...sourceRoots.map(p=>`Sources/${p}`)]).split('\n').sort();
    if(JSON.stringify(originals)!==JSON.stringify(manifest.files.map(e=>e.source).sort())) throw new Error('upstream provenance file set mismatch');
  }
  const actual=await paths(root,vendorRoot);
  const expected=manifest.files.map(entry=>entry.path).sort();
  if(expected.length!==197 || JSON.stringify(actual)!==JSON.stringify(expected)) throw new Error('vendor file set integrity mismatch');
  for(const entry of manifest.files) {
    if(entry.path!==`${vendorRoot}/${entry.source.slice('Sources/'.length)}` || !/^Sources\/KSCrash(?:Core|RecordingCore|Recording)\/(?!.*\.\.)/.test(entry.source) || entry.license!==licenseFor(entry.source) || !/^[a-f0-9]{64}$/.test(entry.originalSha256)) throw new Error('manifest integrity mismatch');
    if(upstreamRoot) {
      const original=await readFile(join(upstreamRoot,entry.source));
      if(sha256(original)!==entry.originalSha256 || sha256(transform(entry.source,original.toString('utf8')))!==entry.packagedSha256) throw new Error('upstream provenance mismatch');
    }
    if(sha256(await readFile(join(root,entry.path)))!==entry.packagedSha256) throw new Error(`source integrity mismatch: ${entry.path}`);
  }
  for(const name of sourceRoots) {
    const original=await readFile(join(root,vendorRoot,name,'Resources/PrivacyInfo.xcprivacy'));
    const packaged=await readFile(join(root,'Sources/EverframeCrashRecorder/Resources',name,'PrivacyInfo.xcprivacy'));
    if(!original.equals(packaged)) throw new Error('resource integrity mismatch');
  }
  return {files:actual.length,revision};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) console.log(await verifyVendor(resolve(process.argv[2]??new URL('..',import.meta.url).pathname), {upstreamRoot:process.env.KSCRASH_CHECKOUT}));
