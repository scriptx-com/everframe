// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { elfFixture } from './elf-build-fixtures.js';
import { uploadAndroidElfBuild } from '../src/elf-upload.js';
import { main } from '../src/index.js';
const roots: string[] = [];
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'elf gate '));
    roots.push(root);
    const symbolsDir = join(root, 'symbols');
    await mkdir(symbolsDir);
    const binaries = [join(root, 'first.so'), join(root, 'second.so')], files = [join(symbolsDir, 'a.so'), join(symbolsDir, 'b.so')];
    for (let i = 0; i < 2; i++) {
        const id = i ? 'abcdef' : '123456';
        await writeFile(binaries[i]!, elfFixture({ id, sections: false }));
        await writeFile(files[i]!, elfFixture({ id }));
    }
    return { root, files, options: { binaries, symbolsDir, appId: 'app', apiUrl: 'http://localhost:12345/api/v1', token: 'fixture-secret' } };
}
function server() {
    const builds = new Map<string, {
        sha: string;
        available: boolean;
        ready: boolean;
    }>(), bodies: Buffer[] = [];
    const hooks: {
        rejectSecond?: boolean;
        retryFirst?: boolean;
        afterPut?: () => Promise<void>;
    } = {};
    let requests = 0, retried = false;
    const status = (id: string) => ({ buildUuid: id, status: builds.get(id)!.ready ? 'ready' : 'uploading', artifacts: [{ artifactUuid: 'artifact', url: 'elf://android/library', available: builds.get(id)!.available }] });
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
        requests++;
        expect(init?.headers).toMatchObject({ authorization: 'Bearer fixture-secret' });
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/source-map-builds') && init?.method === 'POST') {
            const manifest = JSON.parse(String(init.body));
            expect(manifest).toMatchObject({ version: 5, runtime: 'android-native' });
            const sha = manifest.artifacts[0].mapSha256, id = sha.slice(0, 12);
            if (!builds.has(id))
                builds.set(id, { sha, available: false, ready: false });
            return Response.json(status(id));
        }
        const id = path.split('/source-map-builds/')[1]!.split('/')[0]!;
        if (init?.method === 'PUT') {
            const bytes = Buffer.from(init.body as Uint8Array);
            bodies.push(bytes);
            expect(createHash('sha256').update(bytes).digest('hex')).toBe(builds.get(id)!.sha);
            if (hooks.retryFirst && !retried) {
                retried = true;
                return new Response('{}', { status: 503 });
            }
            if (hooks.rejectSecond && builds.size === 2)
                return Response.json({ error: 'invalid_api_token' }, { status: 401 });
            builds.get(id)!.available = true;
            await hooks.afterPut?.();
            return new Response(null, { status: 204 });
        }
        if (path.endsWith('/complete')) {
            expect(builds.get(id)!.available).toBe(true);
            builds.get(id)!.ready = true;
        }
        return Response.json(status(id));
    };
    return { fetcher, hooks, builds, bodies, requests: () => requests };
}
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
it('makes every artifact ready, retries exact bytes after503 and preserves all files', async () => {
    const f = await fixture(), api = server(), before = await Promise.all([...f.options.binaries, ...f.files].map(p => readFile(p)));
    api.hooks.retryFirst = true;
    const result = await uploadAndroidElfBuild(f.options, { fetch: api.fetcher, wait: async () => { } });
    expect(result.images).toHaveLength(2);
    expect(result.artifacts.map(a => a.status)).toEqual(['ready', 'ready']);
    expect(api.bodies).toHaveLength(3);
    expect(api.bodies[0]).toEqual(api.bodies[1]);
    expect(await Promise.all([...f.options.binaries, ...f.files].map(p => readFile(p)))).toEqual(before);
});
it.each(['missing', 'ambiguous', 'wrong-abi', 'stripped'])('makes no request for %s coverage', async (kind) => {
    const f = await fixture(), api = server();
    if (kind === 'missing')
        await rm(f.files[1]!);
    if (kind === 'ambiguous') {
        const b = elfFixture({ id: '123456' });
        b[577] = 3;
        await writeFile(join(f.options.symbolsDir, 'extra.so'), b);
    }
    if (kind === 'wrong-abi')
        await writeFile(f.files[1]!, elfFixture({ id: 'abcdef', machine: 62 }));
    if (kind === 'stripped')
        await writeFile(f.files[1]!, elfFixture({ id: 'abcdef', debug: false }));
    await expect(uploadAndroidElfBuild(f.options, { fetch: api.fetcher })).rejects.toThrow();
    expect(api.requests()).toBe(0);
});
it('fails a later rejected artifact and resumes the already-ready first artifact', async () => {
    const f = await fixture(), api = server();
    api.hooks.rejectSecond = true;
    await expect(uploadAndroidElfBuild(f.options, { fetch: api.fetcher })).rejects.toThrow('invalid_api_token');
    expect([...api.builds.values()].map(b => b.ready)).toEqual([true, false]);
    api.hooks.rejectSecond = false;
    expect((await uploadAndroidElfBuild(f.options, { fetch: api.fetcher })).artifacts.every(a => a.status === 'ready')).toBe(true);
    expect(api.bodies).toHaveLength(3);
});
it.each(['binary', 'symbols', 'parent'])('rejects a late %s change despite a successful server upload', async (kind) => {
    const f = await fixture(), api = server();
    let changed = false;
    api.hooks.afterPut = async () => {
        if (changed)
            return;
        changed = true;
        if (kind === 'parent') {
            const outside = await fixture();
            await rename(f.options.symbolsDir, f.options.symbolsDir + '.old');
            await symlink(outside.options.symbolsDir, f.options.symbolsDir);
        }
        else {
            const path = kind === 'binary' ? f.options.binaries[0]! : f.files[0]!, b = await readFile(path);
            b[577] = 123;
            await writeFile(path, b); // GNU identity stays unchanged.
        }
    };
    await expect(uploadAndroidElfBuild(f.options, { fetch: api.fetcher })).rejects.toThrow(/source_map_changed|symlink_escapes_root/);
});
it('routes repeated binary CLI arguments through exact build coverage', async () => {
    const f = await fixture(), api = server(), log = vi.spyOn(console, 'log').mockImplementation(() => { });
    vi.stubGlobal('fetch', api.fetcher);
    expect(await main(['elf', 'upload-build', '--app-id', 'app', '--symbols-dir', f.options.symbolsDir, ...f.options.binaries.flatMap(p => ['--binary', p])], { EVERFRAME_API_TOKEN: 'fixture-secret', EVERFRAME_API_URL: f.options.apiUrl })).toBe(0);
    expect(api.builds.size).toBe(2);
    expect(log.mock.calls.flat().join(' ')).toContain('2 images');
});
it('rejects missing/unknown/destructive CLI arguments and never logs credentials', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => { }), log = vi.spyOn(console, 'log').mockImplementation(() => { });
    expect(await main(['elf', 'upload-build', '--help'], {})).toBe(0);
    expect(log.mock.calls.flat().join(' ')).toContain('--symbols-dir');
    for (const args of [[], ['--delete-after-upload'], ['--unknown=secret-value']])
        expect(await main(['elf', 'upload-build', ...args], { EVERFRAME_API_TOKEN: 'secret-value' })).toBe(1);
    expect(error.mock.calls.flat().join(' ')).not.toContain('secret-value');
});
it.each([false, true])('shell wrapper quotes paths, inherits credentials and propagates failure (local=%s)', async (local) => {
    const f = await fixture(), capture = join(f.root, 'args.json'), script = join(f.root, local ? 'local entry.mjs' : 'everframe');
    await writeFile(script, '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs"; writeFileSync(process.env.CAPTURE, JSON.stringify({ args: process.argv.slice(2), tokenPresent: process.env.EVERFRAME_API_TOKEN === "fixture-secret" })); process.exit(17);\n');
    await chmod(script, 0o755);
    const env = { ...process.env, EVERFRAME_APP_ID: 'app with spaces', EVERFRAME_API_TOKEN: 'fixture-secret', EVERFRAME_CLI_JS: local ? script : '', CAPTURE: capture, PATH: `${f.root}:${process.env.PATH}` };
    const result = spawnSync('bash', [resolve('examples/upload-android-symbols.sh'), 'symbols with spaces', 'app $literal.so', '--flag-like.so'], { env, encoding: 'utf8' });
    expect(result.status).toBe(17);
    expect(JSON.parse(await readFile(capture, 'utf8'))).toEqual({ args: ['elf', 'upload-build', '--app-id=app with spaces', '--symbols-dir=symbols with spaces', '--binary=app $literal.so', '--binary=--flag-like.so'], tokenPresent: true });
    expect(result.stdout + result.stderr).not.toContain('fixture-secret');
});
