# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
cmake_minimum_required(VERSION 3.22.1)
project(crash_default_fault)
add_library(crash_default_fault SHARED fault.cc)
target_link_options(crash_default_fault PRIVATE -Wl,--build-id=sha1)
target_link_libraries(crash_default_fault log)
