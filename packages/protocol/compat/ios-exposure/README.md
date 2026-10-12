<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->
# Apple native exposure compatibility callers

Compile the old callers against the pre-exposure protocol generation, retain their objects/classes unchanged, then link/run them with the candidate protocol and its typed linkage fixture. This pins the original eight-field NativeCrashMetadata constructors and copy/with symbols. New caller mains check that old copy operations preserve newly received optional evidence. The original Payload signatures remain separately qualified by their existing fixtures.
