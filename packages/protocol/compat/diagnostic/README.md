<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->
# Frozen Payload callers

Compile OldPayloadCaller against the protocol immediately before optional diagnostic evidence was added. Save those object/class bytes, then run against the candidate protocol with a payload containing diagnostic evidence. The copied output must retain the complete evidence and update only extra. Never recompile the saved caller against the candidate: that would hide missing initializer/copy descriptors.

For Kotlin, `check-crash-model-compat.mjs --model Payload` also checks the full old public descriptor set against the candidate. Swift retains both the old initializer and old `with` symbols through PayloadCompat.swift. Generated positional Kotlin fields append diagnostic last so existing component functions and default masks retain their meaning.
