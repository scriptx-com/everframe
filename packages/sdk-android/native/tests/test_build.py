# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
"""Fail-closed checks of build.py that need no NDK, network access or native compilation."""
import ast
import importlib.util
import json
import platform
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / 'build.py'
spec = importlib.util.spec_from_file_location('native_build', SCRIPT)
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
QUALIFIED_HOST = platform.system() == 'Darwin' and platform.machine() == 'arm64'
NDK = json.loads((SCRIPT.parent / 'toolchain-pins.json').read_text())['ndk']
PRERELEASE = f"Pkg.Revision = {NDK['revision']}-beta4\nPkg.BaseRevision = {NDK['revision']}\nPkg.ReleaseName = {NDK['releaseName']}-beta4\n"


def compile_with(ndk_properties):
    """Run a compilation with a fake NDK. A seeded archive that fails its pin keeps it offline."""
    with tempfile.TemporaryDirectory() as temp:
        temp = Path(temp)
        ndk = temp / 'ndk'
        ndk.mkdir()
        (ndk / 'source.properties').write_text(ndk_properties)
        seeded = temp / 'work' / 'vendor' / 'crashpad' / 'crashpad.tar.gz'
        seeded.parent.mkdir(parents=True)
        seeded.write_bytes(b'not an archive')
        return subprocess.run([sys.executable, '-I', '-B', '-O', str(SCRIPT), '--workspace', str(temp / 'work'),
                               '--ndk', str(ndk), '--ninja', str(temp / 'ninja')], capture_output=True, text=True)


class IntegrityChecks(unittest.TestCase):
    def test_checks_are_explicit_so_python_optimization_keeps_them(self):
        asserts = [node.lineno for node in ast.walk(ast.parse(SCRIPT.read_text())) if isinstance(node, ast.Assert)]
        self.assertEqual(asserts, [])

    @unittest.skipUnless(QUALIFIED_HOST, 'the builder refuses other hosts before its toolchain checks')
    def test_wrong_ndk_fails_under_python_optimization(self):
        result = compile_with('Pkg.Desc = Android NDK\nPkg.Revision = 1.0.0\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('NDK', result.stderr)


class NdkIdentity(unittest.TestCase):
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
        result = compile_with(PRERELEASE)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('wrong NDK revision', result.stderr)


if __name__ == '__main__':
    unittest.main()
