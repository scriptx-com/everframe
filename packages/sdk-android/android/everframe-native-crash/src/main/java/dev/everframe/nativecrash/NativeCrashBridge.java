// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.nativecrash;

/** Internal JNI boundary discovered by core. Applications use Everframe's activation methods. */
public final class NativeCrashBridge {
    static { System.loadLibrary("everframe_native_client"); }
    private NativeCrashBridge() {}
    public static native long generation();
    public static native boolean arm(String recordsDirectory, String libraryDirectory, byte[] key, String epoch, long generation);
    public static native void pause();
    public static native boolean revoke();
}
