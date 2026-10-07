// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readBundleIdentity, assertCompiledBuildIdentity } from '../src/bundle-identity.js';
const buildId='11111111-1111-4111-8111-111111111111';
const identity={buildId,platform:'android',bundleName:'index.android.bundle'};
const map=()=>({version:3,sources:[`/.everframe/${buildId}/identity.js`],sourcesContent:[`globalThis.__EVERFRAME_BUILD__ = Object.freeze(${JSON.stringify(identity)});\n`],mappings:''});
const roots:string[]=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
it('reads a generated identity without executing its source',()=>{expect(readBundleIdentity(map(),'android')).toEqual(identity);});
it('accepts generated source identity when source contents were intentionally omitted',()=>{const {sourcesContent,...withoutContents}=map();expect(readBundleIdentity(withoutContents,'android')).toEqual(identity);});
it('accepts Windows source separators',()=>{const input=map();input.sources[0]=input.sources[0]!.replaceAll('/','\\');expect(readBundleIdentity(input,'android')).toEqual(identity);});
it.each([['missing','missing_bundle_identity'],['length-mismatch','invalid_bundle_identity'],['duplicate','ambiguous_bundle_identity'],['malformed','invalid_bundle_identity'],['wrong-platform','invalid_bundle_identity'],['wrong-bundle','invalid_bundle_identity'],['wrong-id','invalid_bundle_identity'],['traversal','missing_bundle_identity']])('rejects %s identity with %s',(kind,code)=>{const input=map();if(kind==='missing'){input.sources=[];input.sourcesContent=[];}if(kind==='length-mismatch')input.sources=[];if(kind==='duplicate'){input.sources.push(input.sources[0]!);input.sourcesContent.push(input.sourcesContent[0]!);}if(kind==='malformed')input.sourcesContent[0]+='globalThis.sideEffect=true;';if(kind==='wrong-platform')input.sourcesContent[0]=input.sourcesContent[0]!.replace('android','ios');if(kind==='wrong-bundle')input.sourcesContent[0]=input.sourcesContent[0]!.replace('index.android.bundle','other.bundle');if(kind==='wrong-id')input.sourcesContent[0]=input.sourcesContent[0]!.replace(buildId,'22222222-2222-4222-8222-222222222222');if(kind==='traversal')input.sources[0]='/.everframe/../identity.js';expect(()=>readBundleIdentity(input,'android')).toThrow(code);});
it('rejects bytecode without the selected ID and finds IDs across stream chunks',async()=>{const root=await mkdtemp(join(tmpdir(),'everframe-identity-'));roots.push(root);const file=join(root,'bundle');await writeFile(file,Buffer.alloc(100));await expect(assertCompiledBuildIdentity(file,buildId)).rejects.toThrow('compiled_build_identity_missing');await writeFile(file,Buffer.concat([Buffer.alloc(65_530),Buffer.from(buildId),Buffer.alloc(100)]));await expect(assertCompiledBuildIdentity(file,buildId)).resolves.toBeUndefined();});
