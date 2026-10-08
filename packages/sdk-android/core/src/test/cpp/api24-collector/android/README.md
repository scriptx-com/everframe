# Android handler qualification

These targets are test-only packaging and execution fixtures, not an SDK collector.
The pinned upstream minimum is API26; API24/25 is unsupported here. Four-ABI ELF
compilation does not establish installed execution. The handler entry requires a bounded credential-checked inherited-FD handshake
before authority admission; installed execution remains a separate gate.

OpenSSL3.5.9 is vendored from its pinned upstream archive under Apache2. Its static
libcrypto is linked privately into the healthy handler, never Android's private
platform libcrypto. Archive/license/tool hashes accompany the build evidence.
No network/customer credentials, production keystore or durable delivery is supplied.

The test host is a nondebuggable/minified Release app with optimized native code.
Owned emulator instrumentation may read ciphertext as root after the fault; the
app/handler keep their unprivileged application UID and enforcing SELinux. The
Android OS may create its own crash diagnostics; the output minimization claim
applies only to this fixture's owned occurrence files and deliberate logging.
Keys are ephemeral: no customer reboot recovery or delivery guarantee exists.
