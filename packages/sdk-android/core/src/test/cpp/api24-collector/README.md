# Healthy-handler qualification fixture

This test executable explores a custom healthy-process Crashpad delegate. It is
not an SDK collector, and does not establish Android version/device support.
The pinned upstream documentation and default build configuration target Android
API26 or later; API24/25 needs a separate support decision.

Use an unmodified standalone Crashpad source tree at the revision in
`dependency-pins.json`, with its pinned dependencies. Copy this directory to
`qualification/` and generate with GN's `--root-target=//qualification:everframe_crash_fixture`.
Build only `everframe_crash_fixture` with two Ninja jobs. Linux requires Clang,
Ninja and OpenSSL development headers. Native Android crypto/packaging is not
selected by this host-only experiment.

The fixture forks a client using Crashpad's existing signal installation and
runs its public exception-handler delegate in the healthy parent. It projects
one exact exception PC and its containing module, marks evidence partial,
encrypts through AES256GCM before opening a record, and preserves fatal exit.
Missing or ambiguous module evidence fails closed. It does not unwind a full
stack, persist a stock minidump, enable an SDK feature or upload records.

Run `everframe_crash_fixture segv /owned/empty/output`, `abort` with another empty
directory, and `crypto-controls` for authenticated-encryption and cap controls.
The minimized JSON result goes to standard output; occurrence files contain
ciphertext alongside the minimal authority journal described below. Run in an isolated container with ptrace permission and core dumps
disabled. The fixture key remains in memory and is discarded after verification.
No production key lifecycle, retention policy or recovery transport is provided.

`authority-controls` exercises healthy-process commit/revoke barriers, stale
random epochs, malformed/missing/partial journals, failed cleanup, interruption
after atomic record commit, and concurrent replay. The stable `authority` inode
holds only a version, random epoch, enabled/used bits and corruption checksum.
It is mode0600 in the owned mode0700 directory; it contains no key or owner.
The checksum is not protection against malicious same-UID code. Revoke fsyncs
disabled state before reporting success/pending cleanup. Re-enable is blocked
until prior cleanup completes, and the controller must allocate a fresh epoch
and key. A deterministic epoch filename and authenticated immutable replay
prevent a second record after commit-before-used interruption. Test barriers and
cleanup-failure injection run only in healthy processes, never the fatal client.

Additional fault modes are `previous-handler`, `worker-segv`, `worker-overflow`,
`existing-altstack`, and `worker-unprepared-overflow`. Prepared worker cases use
the upstream per-thread stack API; they do not magically enroll other existing
threads. The unprepared-overflow control expects fatal SIGSEGV with no record,
explicitly demonstrating an unsupported case. The previous-handler fixture and
first-chance stack probe are signal-safe test instrumentation, not a new SDK
signal collector. One tested predecessor and one large existing stack do not
qualify arbitrary crash-handler coexistence or all stack configurations.

Record files contain authenticated ciphertext; the minimal authority journal is
an intentional plaintext control record. Negative journal/cipher cases retain
corrupt fixture inputs so the runner can verify refusal. No key recovery across
exec/reboot, Android keystore/crypto package, production retention, full unwind,
four-ABI package or installed Android26–30/24–25 support is supplied here.

Initial authority bootstrap requires an otherwise empty owned directory. If a
journal is missing while any retained record or temporary remains, enable is
refused and the retained bytes stay available for explicit cleanup. A refused
bootstrap leaves invalid authority state and does not silently reconstruct it.

Interrupted replay covers pre-link temporary files and post-commit/pre-used
updates. The narrower link-before-temporary-unlink window leaves two hardlinks;
replay refuses that state until explicit revocation/cleanup. It does not create
a second occurrence, and arbitrary storage interruption recovery is not claimed.
