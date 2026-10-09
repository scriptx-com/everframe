# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
"""Fail-closed checks of build.py that need no NDK, network access or native compilation."""
import ast
import importlib.util
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


if __name__ == '__main__':
    unittest.main()
