#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
"""Validate the optional publication boundary without host-specific ELF tools."""
import io
import re
import struct
import sys
import zipfile


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify(filename):
    with zipfile.ZipFile(filename) as aar:
        names = aar.namelist()
        require(len(names) == len(set(names)), "duplicate AAR entries")
        expected = set()
        for abi, elf_class, machine in [
            ("armeabi-v7a", 1, 40), ("arm64-v8a", 2, 183),
            ("x86", 1, 3), ("x86_64", 2, 62),
        ]:
            for library in ["client", "handler", "trampoline"]:
                entry = f"jni/{abi}/libeverframe_native_{library}.so"
                expected.add(entry)
                data = aar.read(entry)
                require(len(data) >= 64 and data[:6] == bytes([127, 69, 76, 70, elf_class, 1])
                        and struct.unpack_from("<H", data, 18)[0] == machine,
                        f"invalid ELF architecture: {entry}")
        require({n for n in names if n.startswith("jni/") and not n.endswith("/")} == expected,
                "unexpected native JNI contents")
        for license_name in ["Crashpad", "OpenSSL", "linux-syscall-support", "mini-chromium", "zlib"]:
            entry = f"assets/everframe-native-licenses/{license_name}.txt"
            require(aar.read(entry).strip(), f"empty license: {entry}")
        rules = aar.read("proguard.txt").decode("utf-8")
        require(re.search(r"-keep\s+class\s+dev\.everframe\.nativecrash\.NativeCrashBridge\s*\{\s*\*;\s*\}", rules),
                "proguard.txt does not preserve the native bridge")
        with zipfile.ZipFile(io.BytesIO(aar.read("classes.jar"))) as classes:
            bridge = "dev/everframe/nativecrash/NativeCrashBridge.class"
            data = classes.read(bridge)
            for method in [b"generation", b"arm", b"pause", b"revoke"]:
                require(method in data, f"missing native bridge method: {method.decode()}")


if __name__ == "__main__":
    try:
        verify(sys.argv[1])
    except (ValueError, KeyError, OSError, zipfile.BadZipFile) as error:
        sys.exit(f"Invalid native-crash AAR: {error}")
