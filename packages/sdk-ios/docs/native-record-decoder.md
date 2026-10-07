<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->
# Native record normalization

The internal decoder accepts the standalone recorder's pinned3.9.0 standard fatal
records in a healthy process. It does not start recording, delete raw files,
recover configuration, or enqueue events. A future recovery coordinator must
resolve the original context and supply its redaction policy.

Input is limited to2MiB, depth64,256 threads and1024 images. Duplicate keys reject.
Structural integer fields reject decimal/exponent token spellings before Foundation
conversion can round them. Ignored vendor metadata may contain fractional numbers.
Only the unique crashed thread is used; its first256 input frames are considered.
Malformed frames/images and missing or ambiguous image matches remain explicitly
incomplete. Unmatched instruction addresses remain available without guessed
image associations. Process/system/memory/register metadata and exception
userInfo are not copied.

The optional crash.native sidecar aligns one-for-one with display frames. Addresses
are exact unsigned64 lowercase hexadecimal strings; timestamps retain exact
microseconds as decimal strings. Images retain UUID, CPU identity, range and
optional VM address, using only redacted basenames. Display frames have no
authored source location. Matching UUID/relative-offset fingerprints are stable
across ASLR within one build; mapped cross-build grouping is a later layer.

The runtime protocol validator additionally checks image ranges, CPU/architecture
consistency and frame associations. Generated JSON Schema expresses structural
limits only; JSON-Schema-only consumers must validate those semantic relationships
before symbolication. Existing payloads without native remain supported.

Host tests exercise real Swift traps, Objective-C exceptions and memory faults,
fresh-process decoding and iOS/tvOS source compilation. They do not establish
installed relaunch recovery, dSYM mapping, production distribution or physical
device behavior.
