# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
"""Fail-closed checks of build.py that need no NDK, network access or native compilation."""
import ast
import hashlib
import importlib.util
import json
import os
import platform
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / 'build.py'
spec = importlib.util.spec_from_file_location('native_build', SCRIPT)
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
QUALIFIED_HOST = platform.system() == 'Darwin' and platform.machine() == 'arm64'
NDK = json.loads((SCRIPT.parent / 'toolchain-pins.json').read_text())['ndk']
PRERELEASE = f"Pkg.Revision = {NDK['revision']}-beta4\nPkg.BaseRevision = {NDK['revision']}\nPkg.ReleaseName = {NDK['releaseName']}-beta4\n"


def compile_with(temp, ndk_properties):
    """Run a compilation in temp/work with a fake NDK. A seeded archive that fails its pin keeps it offline."""
    ndk = temp / 'ndk'
    ndk.mkdir()
    (ndk / 'source.properties').write_text(ndk_properties)
    seeded = temp / 'work' / 'vendor' / 'crashpad' / 'crashpad.tar.gz'
    seeded.parent.mkdir(parents=True, exist_ok=True)
    seeded.write_bytes(b'not an archive')
    return subprocess.run([sys.executable, '-I', '-B', '-O', str(SCRIPT), '--workspace', str(temp / 'work'),
                           '--ndk', str(ndk), '--ninja', str(temp / 'ninja')], capture_output=True, text=True)


class FakeNdk(unittest.TestCase):
    def compile(self, ndk_properties):
        self.temp = Path(self.enterContext(tempfile.TemporaryDirectory()))
        return compile_with(self.temp, ndk_properties)


class IntegrityChecks(FakeNdk):
    def test_checks_are_explicit_so_python_optimization_keeps_them(self):
        asserts = [node.lineno for node in ast.walk(ast.parse(SCRIPT.read_text())) if isinstance(node, ast.Assert)]
        self.assertEqual(asserts, [])

    @unittest.skipUnless(QUALIFIED_HOST, 'the builder refuses other hosts before its toolchain checks')
    def test_wrong_ndk_fails_under_python_optimization(self):
        result = self.compile('Pkg.Desc = Android NDK\nPkg.Revision = 1.0.0\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('NDK', result.stderr)


class NdkIdentity(FakeNdk):
    def check(self, properties):
        with tempfile.TemporaryDirectory() as ndk:
            (Path(ndk) / 'source.properties').write_text('Pkg.Desc = Android NDK\n' + properties)
            build.check_ndk(Path(ndk), NDK)

    def test_pin_names_a_stable_release(self):
        self.assertRegex(NDK['releaseName'], r'^r[0-9]+[a-z]?$')

    def test_exact_pinned_ndk_is_accepted(self):
        self.check(f"Pkg.Revision = {NDK['revision']}\nPkg.ReleaseName = {NDK['releaseName']}\n")

    def test_prerelease_sharing_the_pinned_base_revision_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'wrong NDK revision'):
            self.check(PRERELEASE)

    def test_release_name_must_match_the_pin(self):
        with self.assertRaisesRegex(ValueError, 'wrong NDK revision'):
            self.check(f"Pkg.Revision = {NDK['revision']}\nPkg.ReleaseName = {NDK['releaseName']}-beta4\n")

    @unittest.skipUnless(QUALIFIED_HOST, 'the builder refuses other hosts before its toolchain checks')
    def test_prerelease_ndk_stops_compilation_before_source_preparation(self):
        result = self.compile(PRERELEASE)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('wrong NDK revision', result.stderr)


class WorkspaceVerification(FakeNdk):
    def workspace(self, abis=tuple(build.ABIS)):
        work = Path(self.enterContext(tempfile.TemporaryDirectory()))
        artifacts = {}
        for abi in abis:
            (work / 'jniLibs' / abi).mkdir(parents=True)
            for role in ('client', 'handler', 'trampoline'):
                name = f'{abi}/libeverframe_native_{role}.so'
                (work / 'jniLibs' / name).write_bytes(name.encode())
                artifacts[name] = {'sha256': hashlib.sha256(name.encode()).hexdigest()}
        proof = {'sources': build.source_hashes(), 'artifacts': artifacts, 'abis': list(abis)}
        (work / 'native-build.json').write_text(json.dumps(proof))
        return work

    def refuse(self, work, message, abis=tuple(build.ABIS)):
        with self.assertRaisesRegex(ValueError, message):
            build.verify(work, list(abis))

    def test_consistent_workspace_passes(self):
        build.verify(self.workspace(), list(build.ABIS))

    def test_changed_artifact_is_refused(self):
        work = self.workspace()
        (work / 'jniLibs/x86/libeverframe_native_handler.so').write_bytes(b'tampered')
        self.refuse(work, 'native artifact mismatch: x86/libeverframe_native_handler.so')

    def test_missing_artifact_is_refused(self):
        work = self.workspace()
        (work / 'jniLibs/x86_64/libeverframe_native_client.so').unlink()
        self.refuse(work, 'x86_64/libeverframe_native_client.so')

    def test_changed_sources_are_refused(self):
        work = self.workspace()
        proof = json.loads((work / 'native-build.json').read_text())
        proof['sources']['client.cc'] = '0' * 64
        (work / 'native-build.json').write_text(json.dumps(proof))
        self.refuse(work, 'native sources changed')

    def test_missing_proof_is_refused(self):
        work = self.workspace()
        (work / 'native-build.json').unlink()
        self.refuse(work, 'native-build.json')

    def test_proof_for_fewer_abis_is_refused(self):
        self.refuse(self.workspace(('arm64-v8a',)), 'armeabi-v7a/libeverframe_native_client.so')

    def test_extra_library_beside_verified_artifacts_is_refused(self):
        work = self.workspace()
        (work / 'jniLibs/arm64-v8a/libold.so').write_bytes(b'unverified')
        self.refuse(work, 'arm64-v8a/libold.so')

    def test_unverified_abi_directory_is_refused(self):
        work = self.workspace()
        (work / 'jniLibs/riscv64').mkdir()
        (work / 'jniLibs/riscv64/libextra.so').write_bytes(b'unverified')
        self.refuse(work, 'riscv64/libextra.so')

    def test_single_abi_request_refuses_other_packaged_abis(self):
        self.refuse(self.workspace(), 'x86/libeverframe_native_client.so', abis=('arm64-v8a',))

    def test_verify_only_command_fails_closed(self):
        work = self.workspace()
        (work / 'jniLibs/arm64-v8a/libold.so').write_bytes(b'unverified')
        result = subprocess.run([sys.executable, '-I', '-B', str(SCRIPT), '--workspace', str(work), '--abi', 'all',
                                 '--verify-only'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('arm64-v8a/libold.so', result.stderr)
        self.assertNotIn('PASS', result.stdout)

    @unittest.skipUnless(QUALIFIED_HOST, 'the builder refuses other hosts before its toolchain checks')
    def test_compilation_discards_the_previous_proof_and_libraries(self):
        self.temp = Path(self.enterContext(tempfile.TemporaryDirectory()))
        work = self.temp / 'work'
        (work / 'jniLibs/riscv64').mkdir(parents=True)
        (work / 'jniLibs/riscv64/libold.so').write_bytes(b'left from another layout')
        (work / 'native-build.json').write_text('{}')
        result = compile_with(self.temp, f"Pkg.Revision = {NDK['revision']}\nPkg.ReleaseName = {NDK['releaseName']}\n")
        self.assertIn('source pin mismatch: crashpad', result.stderr)
        self.assertFalse((work / 'jniLibs').exists())
        self.assertFalse((work / 'native-build.json').exists())


class IncrementalReuse(FakeNdk):
    DERIVED = ('crypto/x86', 'vendor/crashpad/source/out/Android-x86', 'vendor/gn', 'vendor/openssl-3.5.9')
    DOWNLOADS = ('vendor/crashpad/crashpad.tar.gz', 'vendor/openssl-3.5.9.tar.gz', 'vendor/gn-mac-arm64.zip')

    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))

    def sources(self, **files):
        source = self.root / 'source'
        source.mkdir(exist_ok=True)
        for name, text in files.items():
            (source / name.replace('_', '.')).write_text(text)
        return source

    def test_changed_source_is_rewritten_even_when_the_checkout_is_older(self):
        destination = self.root / 'everframe_native'
        build.sync_sources(self.sources(client_cc='v1'), destination)
        copied = time.time() - 7200
        os.utime(destination / 'client.cc', (copied, copied))
        source = self.sources(client_cc='v2')
        os.utime(source / 'client.cc', (copied - 3600, copied - 3600))
        build.sync_sources(source, destination)
        self.assertEqual((destination / 'client.cc').read_text(), 'v2')
        self.assertGreater((destination / 'client.cc').stat().st_mtime, copied + 3600)

    def test_unchanged_source_keeps_its_time_for_incremental_builds(self):
        destination = self.root / 'everframe_native'
        source = self.sources(client_cc='same')
        build.sync_sources(source, destination)
        copied = time.time() - 7200
        os.utime(destination / 'client.cc', (copied, copied))
        build.sync_sources(source, destination)
        self.assertEqual(int((destination / 'client.cc').stat().st_mtime), int(copied))

    def test_removed_and_non_source_files_are_not_compiled(self):
        destination = self.root / 'everframe_native'
        destination.mkdir()
        (destination / 'removed.h').write_text('stale')
        source = self.sources(client_cc='c', BUILD_gn='g', README_md='r', build_py='p')
        (source / 'tests').mkdir()
        build.sync_sources(source, destination)
        self.assertEqual(sorted(p.name for p in destination.iterdir()), ['BUILD.gn', 'client.cc'])

    def workspace(self, recorded):
        work = self.root / 'work'
        for directory in self.DERIVED:
            (work / directory).mkdir(parents=True)
        for download in self.DOWNLOADS:
            (work / download).write_bytes(b'cached download')
        if recorded is not None:
            (work / 'build-inputs.json').write_text(json.dumps(recorded))
        return work

    def assert_reset(self, work, reset):
        for directory in self.DERIVED:
            self.assertEqual((work / directory).exists(), not reset, directory)
        for download in self.DOWNLOADS:
            self.assertTrue((work / download).is_file(), download)

    def test_changed_inputs_discard_reused_build_state_but_keep_downloads(self):
        work = self.workspace({'toolchain-pins.json': 'old'})
        build.reset_changed_inputs(work, {'toolchain-pins.json': 'new'})
        self.assert_reset(work, True)
        self.assertEqual(json.loads((work / 'build-inputs.json').read_text()), {'toolchain-pins.json': 'new'})

    def test_identical_inputs_keep_build_state(self):
        work = self.workspace({'toolchain-pins.json': 'same'})
        build.reset_changed_inputs(work, {'toolchain-pins.json': 'same'})
        self.assert_reset(work, False)

    def test_workspace_without_recorded_inputs_is_rebuilt(self):
        work = self.workspace(None)
        build.reset_changed_inputs(work, {'toolchain-pins.json': 'new'})
        self.assert_reset(work, True)

    def test_inputs_cover_the_builder_its_pins_and_the_ndk(self):
        inputs = build.build_inputs(Path('/ndk/a'))
        self.assertEqual(set(inputs), {'ndk', 'build.py', 'source-pins.json', 'toolchain-pins.json'})
        self.assertNotEqual(inputs, build.build_inputs(Path('/ndk/b')))

    @unittest.skipUnless(QUALIFIED_HOST, 'the builder refuses other hosts before its toolchain checks')
    def test_compilation_resets_state_built_from_other_inputs(self):
        work = self.workspace(None)
        result = compile_with(self.root, f"Pkg.Revision = {NDK['revision']}\nPkg.ReleaseName = {NDK['releaseName']}\n")
        self.assertIn('source pin mismatch: crashpad', result.stderr)
        self.assert_reset(work, True)
        self.assertEqual(json.loads((work / 'build-inputs.json').read_text()), build.build_inputs((self.root / 'ndk').resolve()))


if __name__ == '__main__':
    unittest.main()
