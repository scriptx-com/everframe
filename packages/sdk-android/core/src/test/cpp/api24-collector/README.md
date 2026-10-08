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
The JSON result goes to standard output; record directories contain only
ciphertext. Run in an isolated container with ptrace permission and core dumps
disabled. The fixture key remains in memory and is discarded after verification.
No production key lifecycle, retention policy or recovery transport is provided.
