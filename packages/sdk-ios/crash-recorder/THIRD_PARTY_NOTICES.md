<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Third-party recording source

KSCrash 2.6.0, revision `3f77f379c2db001e0c261c2a51b7e2b115d31f91`,
from https://github.com/kstenerud/KSCrash. Only KSCrashCore,
KSCrashRecordingCore and KSCrashRecording are included. Original per-file
copyright and license notices are preserved. No ownership of upstream code is claimed.

Most files are MIT licensed; see LICENSES/MIT.txt and the original notices.
`KSCrashRecordingCore/KSObjCApple.h` is APSL-2.0 (Apple, 2011).
`KSCrashRecordingCore/KSMach-O.c` combines MIT (Yandex, 2019) and
APSL-2.0 (Apple, 1999). `KSCrashRecordingCore/KSCxaThrowSwapper.c`
combines MIT (Yandex, 2019) and BSD-3-Clause (Facebook, 2013).
Full Apple and BSD terms are in LICENSES/APSL-2.0.txt and LICENSES/BSD-3-Clause.txt.

Modifications by ScriptX, dated 2026-10-07: accurate SPDX metadata, preserved
notices, a private namespace prelude in every translation unit, and replacement
of the sidecar NSFileProtectionNone policy with
NSFileProtectionCompleteUntilFirstUserAuthentication in KSFileUtilsObjC.m.
NSException metadata collection is also removed: the owned monitor neither reads
nor formats `exception.userInfo`, and records NULL for that field.
The Resource monitor in KSCrashMonitor_Resource.m no longer enables or disables
UIDevice battery monitoring; it records battery state only while the host
application enables monitoring.
The historical upstream helper name still says “NoFileProtection”; the modified
implementation preserves the component's mobile protection policy.

The original and modified SHA-256 for every file are recorded in vendor-lock.json.
Corresponding modified source is distributed in this directory in the public
https://github.com/scriptx-com/everframe repository. Apple-covered modifications
remain under APSL-2.0; the owned wrapper and preparation scripts are MIT.
