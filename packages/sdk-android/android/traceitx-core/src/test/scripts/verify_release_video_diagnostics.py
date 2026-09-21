#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX

"""Check compiled release code, rather than disabled release unit tests or source text.
Run after :traceitx-core:compileReleaseKotlin. No Android device needed.
"""
import os
from pathlib import Path
import re
import subprocess
import sys

module = Path(__file__).resolve().parents[3]
classes = Path(sys.argv[1]) if len(sys.argv) > 1 else module / "build/tmp/kotlin-classes/release"
javap = str(Path(os.environ["JAVA_HOME"]) / "bin/javap")


def disassemble(path):
    return subprocess.check_output([javap, "-c", "-p", str(path)], text=True)


def assert_inert(class_file, method):
    listing = disassemble(classes / class_file)
    match = re.search(r"\n  [^\n]* " + re.escape(method) + r"[^\n]*\n    Code:\n(.*?)(?=\n  \S|\n})", listing, re.S)
    assert match, f"Missing compiled release method {method}"
    instructions = re.findall(r"^\s+\d+: (\S+)", match[1], re.M)
    assert instructions == ["aconst_null", "areturn"], (method, instructions)


assert_inert("com/traceitx/TraceItX.class", "__nativeVideoDiagnostics()")
assert_inert("com/traceitx/capture/replay/ReplaySession.class", "nativeVideoDiagnostics")
# The release callback must not snapshot or retain a recorder during report completion.
callbacks = list((classes / "com/traceitx/capture/replay").glob("ReplaySession*.class"))
assert callbacks, "Compile release classes first"
for callback in callbacks:
    assert "diagnosticSnapshot" not in disassemble(callback), callback.name
print("PASS: release host/session accessors return null without state reads or calls; no release recorder snapshot collection")
