// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const revision = '3f77f379c2db001e0c261c2a51b7e2b115d31f91';
export const sourceRoots = ['KSCrashCore', 'KSCrashRecordingCore', 'KSCrashRecording'];
export const vendorRoot = 'Sources/EverframeCrashRecorder/Vendor';
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export function licenseFor(path) {
  if (path.endsWith('/KSObjCApple.h')) return 'APSL-2.0';
  if (path.endsWith('/KSMach-O.c')) return 'MIT AND APSL-2.0';
  if (path.endsWith('/KSCxaThrowSwapper.c')) return 'MIT AND BSD-3-Clause';
  return 'MIT';
}
const appleNotice = `// The Original Code and all software distributed under the License are
// distributed on an 'AS IS' basis, WITHOUT WARRANTY OF ANY KIND, EITHER
// EXPRESS OR IMPLIED, AND APPLE HEREBY DISCLAIMS ALL SUCH WARRANTIES,
// INCLUDING WITHOUT LIMITATION, ANY WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE, QUIET ENJOYMENT OR NON-INFRINGEMENT.
// Please see the License for the specific language governing rights and
// limitations under the License.
`;
export function transform(path, original) {
  const license = licenseFor(path);
  const changes = ['license metadata'];
  const translationUnit = /\.(c|m|cpp)$/.test(path);
  if (translationUnit) changes.push('private namespace prelude');
  if (path.endsWith('/KSFileUtilsObjC.m')) {
    if ((original.match(/NSFileProtectionNone/g) ?? []).length !== 1) throw new Error('unexpected protection patch input');
    original = original.replace('NSFileProtectionNone', 'NSFileProtectionCompleteUntilFirstUserAuthentication');
    changes.push('preserve complete-until-first-authentication file protection');
  }
  if (path.endsWith('.xcprivacy')) {
    return original.replace(/(<\?xml[^>]+\?>\s*)/, `$1<!-- SPDX-License-Identifier: ${license}\nModified by ScriptX on 2026-10-07: ${changes.join('; ')}. Original notices retained. -->\n`);
  }
  return `// SPDX-License-Identifier: ${license}\n// Modified by ScriptX on 2026-10-07: ${changes.join('; ')}.\n// Original copyright and license notices retained below.\n` +
    (translationUnit ? '#include "EverframeKSCrashNamespace.h"\n' : '') +
    (path.endsWith('/KSObjCApple.h') ? appleNotice : '') + original;
}
export async function prepareVendor({ upstreamRoot, outputRoot }) {
  const git = args => execFileSync('git',['-C',upstreamRoot,...args],{encoding:'utf8'}).trim();
  if (git(['rev-parse','HEAD']) !== revision) throw new Error('upstream revision mismatch');
  const sources = sourceRoots.map(root=>`Sources/${root}`);
  if (git(['status','--porcelain','--',...sources])) throw new Error('upstream sources modified');
  const paths = git(['ls-tree','-r','--name-only','HEAD','--',...sources]).split('\n').sort();
  // Refuse to replace any existing vendor evidence or source automatically.
  try { if ((await readdir(join(outputRoot,vendorRoot))).length) throw new Error('output vendor directory must be empty'); }
  catch(error) { if(error.code !== 'ENOENT') throw error; }
  const files=[];
  for (const source of paths) {
    const original = await readFile(join(upstreamRoot,source));
    const path = `${vendorRoot}/${source.slice('Sources/'.length)}`;
    const packaged = transform(source,original.toString('utf8'));
    await mkdir(dirname(join(outputRoot,path)),{recursive:true});
    await writeFile(join(outputRoot,path),packaged);
    if(source.endsWith('/Resources/PrivacyInfo.xcprivacy')) {
      const resource=join(outputRoot,'Sources/EverframeCrashRecorder/Resources',source.split('/')[1],'PrivacyInfo.xcprivacy');
      await mkdir(dirname(resource),{recursive:true}); await writeFile(resource,packaged);
    }
    files.push({source,path,license:licenseFor(source),originalSha256:sha256(original),packagedSha256:sha256(packaged)});
  }
  const manifest={schemaVersion:1,upstream:'https://github.com/kstenerud/KSCrash',version:'2.6.0',revision,files};
  await writeFile(join(outputRoot,'vendor-lock.json'),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv.length!==4) throw new Error('Usage: node prepare-vendor.mjs UPSTREAM_CHECKOUT EMPTY_OUTPUT_ROOT');
  await prepareVendor({upstreamRoot:resolve(process.argv[2]),outputRoot:resolve(process.argv[3])});
}
