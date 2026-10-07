# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
cmake_minimum_required(VERSION 3.22)
project(everframe_native_proof LANGUAGES CXX)
add_library(nativeproof SHARED NativeFaults.cpp)
target_link_options(nativeproof PRIVATE -Wl,--build-id=sha1 -Wl,-z,max-page-size=16384)
