<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->
# Native record normalization

The internal decoder accepts the standalone recorder's pinned 3.9.0 standard fatal
records in a healthy process. It does not start recording, delete raw files,
recover configuration, or enqueue events. A future recovery coordinator must
resolve the original context and supply its redaction policy.

Input is limited to 2 MiB, depth 64 and 1000 threads (the pinned recorder's own
maximum). Every image entry within that input is scanned, and only images referenced
by normalized frames are emitted. Duplicate keys reject.
Structural integer fields reject decimal/exponent token spellings before Foundation
conversion can round them. Ignored vendor metadata may contain fractional numbers.
Only the unique crashed thread is used, except that NSException records normalize the
exception's own backtrace (last_exception_backtrace) when it has frames: the uncaught
handler's stack can already be unwound past the throw site. A malformed exception
backtrace falls back to the handler stack and marks frames incomplete. The pinned
recorder writes at most 94 handler frames with no truncation marker, so a handler
stack of that size is also marked incomplete. The first 256 input frames are
considered.
Malformed frames/images and missing or ambiguous image matches remain explicitly
incomplete. Unmatched instruction addresses remain available without guessed
image associations. Process/system/memory/register metadata and exception
userInfo are not copied. Freeform text reaches the supplied redactor as a window of
twice its output limit, with control characters replaced by spaces so separators
keep word boundaries; the redacted text is then stripped of controls and capped.
Redaction matches secrets such as JWTs and card numbers only whole, so when the
window cuts the exception type or message, the cut token and any digit group before
it are dropped first, as in cause chains. Symbol and image names come from binaries
and keep their cut.
Without a recorded reason, the message comes from runtime crash info (for example
Swift fatalError text) in images the normalized frames reference, in frame order;
otherwise it is the exception type.

The optional crash.native sidecar aligns one-for-one with display frames. Addresses
are exact unsigned64 lowercase hexadecimal strings; timestamps retain exact
microseconds as decimal strings. Images retain UUID, CPU identity, range and
optional VM address, using only redacted basenames. Display frames have no
authored source location. The fingerprint hashes the exception type with the
UUID/relative-offset keys of the first five frames in app images. OS images (paths
under /System, /usr/lib, /Library/Apple, /private/preboot or a simulator
RuntimeRoot) are skipped: they hold terminate/abort machinery and change with OS
updates. Without any app frame, the first five frames are used. They are also used
when the crashing frame is outside app images and every app frame belongs to the entry
point: the app frames directly above the stack's final OS frame, the loader's start
(main, or $main and main, plus any app code main calls directly). Faults inside OS
code, such as over-releases in a Core Animation commit, then stay apart instead of
sharing main's key, but their keys change with OS updates. Keys are stable across
ASLR within one app build; mapped cross-build grouping is a later layer.

The runtime protocol validator additionally checks image ranges, CPU/architecture
consistency and frame associations. Generated JSON Schema expresses structural
limits only; JSON-Schema-only consumers must validate those semantic relationships
before symbolication. Existing payloads without native remain supported.

Unit tests decode synthetic records. A separate, externally driven harness
(Tests/NativeCrashRecordProof, not part of `swift test`) decodes real Swift traps,
Objective-C exceptions and memory faults from the recorder probe in fresh macOS
processes. For iOS 15 and tvOS 15 simulators the decoder sources are only
type-checked. None of this establishes installed relaunch recovery, dSYM mapping,
production distribution or physical device behavior.
