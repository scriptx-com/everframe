#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
"""Build the optional Android native module from verified, pinned public sources.

Build host: macOS arm64, Python3.12+, NDK29, make/perl and SDK CMake ninja.
No artifact is downloaded without an immutable content check. Outputs stay in --workspace.
"""
import argparse, hashlib, io, json, os, platform, shutil, subprocess, tarfile, time, urllib.request, zipfile
from pathlib import Path

SOURCE = Path(__file__).resolve().parent
ABIS = {'arm64-v8a': ('arm64','android-arm64'), 'armeabi-v7a': ('arm','android-arm'),
        'x86': ('x86','android-x86'), 'x86_64': ('x64','android-x86_64')}

def require(condition, message):
    # Explicit, so python3 -O and PYTHONOPTIMIZE cannot remove an integrity check.
    if not condition: raise ValueError(message)

def digest(path):
    return hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()

def git_tree(data, strip):
    root = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as tar:
        for m in tar.getmembers():
            parts = Path(m.name).parts[1:] if strip else Path(m.name).parts
            if not parts or m.isdir(): continue
            if m.isfile(): mode, blob = ('100755' if m.mode & 0o100 else '100644'), tar.extractfile(m).read()
            elif m.issym(): mode, blob = '120000', m.linkname.encode()
            else: raise ValueError('unsupported archive entry')
            node = root
            for name in parts[:-1]: node = node.setdefault(name, {})
            node[parts[-1]] = (mode, hashlib.sha1(b'blob %d\0' % len(blob) + blob).digest())
    def tree(node):
        rows = [(name.encode()+b'/', b'40000 '+name.encode()+b'\0'+tree(v)) if isinstance(v,dict)
                else (name.encode(),v[0].encode()+b' '+name.encode()+b'\0'+v[1]) for name,v in node.items()]
        body = b''.join(v for _,v in sorted(rows))
        return hashlib.sha1(b'tree %d\0'%len(body)+body).digest()
    return tree(root).hex()

def download(url, path, check):
    if not path.exists():
        partial = path.with_suffix(path.suffix+'.partial')
        with urllib.request.urlopen(url, timeout=120) as src, partial.open('wb') as dst: shutil.copyfileobj(src,dst)
        check(partial); partial.replace(path)
    check(path)

def extract(archive, dest, strip=False):
    dest.mkdir(parents=True,exist_ok=True)
    with tarfile.open(archive) as tar:
        members=[]
        for m in tar.getmembers():
            if strip:
                parts=Path(m.name).parts[1:]
                if not parts: continue
                m.name=str(Path(*parts))
            members.append(m)
        tar.extractall(dest,members=members,filter='data')

def source_hashes():
    return {p.name:digest(p) for p in sorted(SOURCE.iterdir()) if p.is_file() and p.suffix in ('.cc','.h','.gn','.json','.patch','.py')}

def verify(work, abis):
    proof=json.loads((work/'native-build.json').read_text())
    if proof['sources'] != source_hashes(): raise ValueError('native sources changed; rebuild before packaging')
    for abi in abis:
        for role in ('client','handler','trampoline'):
            name=f'{abi}/libeverframe_native_{role}.so'
            if digest(work/'jniLibs'/name)!=proof['artifacts'][name]['sha256']: raise ValueError('native artifact mismatch: '+name)
    return proof

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--workspace',required=True,type=Path)
    ap.add_argument('--ndk',type=Path);ap.add_argument('--ninja',type=Path)
    ap.add_argument('--abi',choices=['all',*ABIS],default='all');ap.add_argument('--verify-only',action='store_true');a=ap.parse_args()
    work=a.workspace.resolve();abis=list(ABIS) if a.abi=='all' else [a.abi]
    if a.verify_only: verify(work,abis);print('PASS verified native inputs and packaged outputs');return
    if platform.system()!='Darwin' or platform.machine()!='arm64': raise SystemExit('qualified build host is macOS arm64')
    require(a.ndk and a.ninja,'--ndk and --ninja required for compilation')
    pins=json.loads((SOURCE/'toolchain-pins.json').read_text());ndk=a.ndk.resolve()
    require(('Pkg.Revision = '+pins['ndk']) in (ndk/'source.properties').read_text(),'wrong NDK revision')
    vendor=work/'vendor';vendor.mkdir(parents=True,exist_ok=True)
    upstream=vendor/'crashpad';upstream.mkdir(exist_ok=True);src=upstream/'source'
    destinations={'crashpad':'','mini_chromium':'third_party/mini_chromium/mini_chromium',
        'lss':'third_party/lss/lss','zlib':'third_party/zlib/zlib','googletest':'third_party/googletest/googletest'}
    for pin in json.loads((SOURCE/'source-pins.json').read_text())['upstreamSources']:
        name=pin['name'];strip=name in ('crashpad','googletest');archive=upstream/(name+'.tar.gz')
        def check(p,pin=pin,strip=strip):
            actual=git_tree(p.read_bytes(),strip) if 'gitTree' in pin else digest(p)
            require(actual==pin.get('gitTree',pin.get('sha256')),'source pin mismatch: '+pin['name'])
        download(pin['url'],archive,check)
        extract(archive,src/destinations[name],strip)
    crypto_pin=pins['openssl'];archive=vendor/('openssl-'+crypto_pin['version']+'.tar.gz')
    def hash_check(expected):
        def check(p): require(digest(p)==expected,'archive hash mismatch: '+str(p))
        return check
    download(crypto_pin['url'],archive,hash_check(crypto_pin['sha256']))
    extract(archive,vendor);crypto_source=vendor/('openssl-'+crypto_pin['version'])
    require(digest(crypto_source/'LICENSE.txt')==crypto_pin['licenseSha256'],'OpenSSL license hash mismatch')
    gn_pin=pins['gn'];gn_zip=vendor/'gn-mac-arm64.zip'
    download('https://chrome-infra-packages.appspot.com/dl/gn/gn/mac-arm64/+/git_revision:'+gn_pin['revision'],gn_zip,hash_check(gn_pin['macArm64ArchiveSha256']))
    gn_dir=vendor/'gn';gn_dir.mkdir(exist_ok=True)
    with zipfile.ZipFile(gn_zip) as z:
        for m in z.infolist(): require((gn_dir/m.filename).resolve().is_relative_to(gn_dir.resolve()),'GN archive entry escapes its directory: '+m.filename)
        z.extractall(gn_dir)
    gn=gn_dir/'gn';gn.chmod(0o755)
    overlay=pins['buildOnlyOverlay'];patch=SOURCE/overlay['file'];require(digest(patch)==overlay['sha256'],'build overlay hash mismatch')
    mini=src/'third_party/mini_chromium/mini_chromium';config=mini/'build/config/BUILD.gn'
    require(digest(config)==overlay['beforeSha256'],'mini_chromium build config differs from the overlay base')
    subprocess.run(['patch','-p1','-i',str(patch)],cwd=mini,check=True)
    require(digest(config)==overlay['afterSha256'],'mini_chromium build config differs from the overlay result')
    destination=src/'everframe_native';destination.mkdir(exist_ok=True)
    for p in SOURCE.iterdir():
        if p.is_file() and p.suffix in ('.cc','.h','.gn'): shutil.copy2(p,destination/p.name)
    ndkbin=ndk/'toolchains/llvm/prebuilt/darwin-x86_64/bin';env=os.environ.copy()
    env.update(ANDROID_NDK_ROOT=str(ndk),PATH=str(ndkbin)+os.pathsep+env['PATH'])
    commands=[];logs=work/('logs-'+str(time.time_ns()));logs.mkdir(exist_ok=False);print('Build logs:',logs,flush=True)
    def run(argv,cwd,tag):
        commands.append({'argv':list(map(str,argv)),'cwd':str(cwd)})
        with (logs/(tag+'.log')).open('w') as out:
            subprocess.run(list(map(str,argv)),cwd=cwd,env=env,stdout=out,stderr=subprocess.STDOUT,check=True)
    artifacts={}
    for abi in abis:
        cpu,target=ABIS[abi];crypto=work/'crypto'/abi;crypto.mkdir(parents=True,exist_ok=True)
        # Configure every time so a copied cache cannot retain a different source/toolchain.
        run(['perl',crypto_source/'Configure',target,'-D__ANDROID_API__=26','no-shared','no-tests','no-apps','no-module','no-legacy','no-engine','no-dso','no-comp','no-ssl','-fPIC'],crypto,abi+'-configure')
        run(['make','-j2','build_libs'],crypto,abi+'-crypto')
        shutil.copytree(crypto_source/'include',crypto/'include',dirs_exist_ok=True)
        out=src/'out'/('Android-'+abi)
        args=f'target_os="android" target_cpu="{cpu}" android_api_level=26 android_ndk_root="{ndk}" is_debug=false everframe_crypto_root="{crypto}"'
        run([gn,'gen',out,'--root-target=//everframe_native:artifacts','--args='+args],src,abi+'-gn')
        run([a.ninja,'-j2','-C',out,'everframe_native:artifacts'],src,abi+'-native')
        dest=work/'jniLibs'/abi;dest.mkdir(parents=True,exist_ok=True)
        for role in ('client','handler','trampoline'):
            name=f'libeverframe_native_{role}.so';files=list(out.rglob(name));require(len(files)==1,'expected one built '+name)
            shutil.copy2(files[0],dest/name)
            details=subprocess.check_output([str(ndkbin/'llvm-readelf'),'-d','-n',str(dest/name)],text=True)
            import re
            needed=re.findall(r'\(NEEDED\).*?\[(.*?)\]',details)
            require(set(needed)<={'libc.so','libdl.so','liblog.so','libm.so'},f'unexpected NEEDED libraries in {abi}/{name}: {needed}')
            build=re.search(r'Build ID: ([0-9a-f]+)',details);require(build,f'missing ELF build ID: {abi}/{name}')
            artifacts[f'{abi}/{name}']={'sha256':digest(dest/name),'buildId':build.group(1),'needed':needed}
    # A partial build cannot certify stale artifacts from other ABIs.
    proof={'sources':source_hashes(),'artifacts':artifacts,'commands':commands,'abis':abis}
    (work/'native-build.json').write_text(json.dumps(proof,indent=2)+'\n')
    verify(work,abis);print('PASS native source build:',','.join(abis))
if __name__=='__main__':main()
