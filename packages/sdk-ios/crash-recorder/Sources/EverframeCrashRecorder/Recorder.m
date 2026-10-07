// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#include "EverframeKSCrashNamespace.h"
#include "include/EverframeCrashRecorder.h"
#include "RecorderGate.h"
#include "KSCrashC.h"
#include "KSCrashCConfiguration.h"
#include "KSCrashMonitor.h"
#include "KSCrashMonitor_System.h"
#import <Foundation/Foundation.h>
#include <TargetConditionals.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <sys/stat.h>
#include <unistd.h>
// The System monitor formats <run>/RunSidecars/<36-character run ID>/System.ksscr into a
// KSSYS_MAX_PATH buffer, the smallest run-path buffer in the vendor recorder.
#define EFCR_MAX_RUN_PATH (KSSYS_MAX_PATH - (sizeof("/RunSidecars/") - 1) - 36 - sizeof("/System.ksscr"))
static pthread_mutex_t installLock = PTHREAD_MUTEX_INITIALIZER;
static bool attempted = false;
static bool installed = false;

static bool validDirectory(const char *path, char canonical[PATH_MAX]) {
    if (!path || path[0] != '/' || strnlen(path, PATH_MAX) > EFCR_MAX_RUN_PATH) return false;
    if (!realpath(path, canonical) || strlen(canonical) > EFCR_MAX_RUN_PATH) return false;
    // Foundation reports /var and /tmp locations without the /private prefix realpath(3) adds.
    if (strcmp(path, canonical) != 0 &&
        (strncmp(canonical, "/private/", 9) != 0 || strcmp(path, canonical + 8) != 0)) return false;
    int fd = open(canonical, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return false;
    struct stat st;
    if (fstat(fd, &st) != 0 || !S_ISDIR(st.st_mode) || st.st_uid != geteuid() || (st.st_mode & 07777) != 0700) {
        close(fd); return false;
    }
    DIR *dir = fdopendir(fd);
    if (!dir) { close(fd); return false; }
    bool empty = true;
    struct dirent *entry;
    errno = 0;
    while ((entry = readdir(dir))) {
        if (strcmp(entry->d_name, ".") != 0 && strcmp(entry->d_name, "..") != 0) { empty = false; break; }
    }
    if (errno != 0) empty = false;
    closedir(dir);
    return empty;
}

static bool protectDirectory(const char *path) {
    NSString *value = [[NSString alloc] initWithUTF8String:path];
    if (!value) return false;
    NSURL *url = [NSURL fileURLWithPath:value isDirectory:YES];
    if (![url setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil]) return false;
#if TARGET_OS_IOS || TARGET_OS_TV
    if (![[NSFileManager defaultManager] setAttributes:@{NSFileProtectionKey:NSFileProtectionCompleteUntilFirstUserAuthentication}
                                         ofItemAtPath:value error:nil]) return false;
#endif
    return true;
}

EFCRInstallResult EFCRInstall(const char *runDirectory) {
    pthread_mutex_lock(&installLock);
    EFCRInstallResult result;
    char canonical[PATH_MAX];
    if (attempted) result = installed ? EFCRInstallAlreadyInstalled : EFCRInstallVendorFailure;
    else if (!validDirectory(runDirectory, canonical)) result = EFCRInstallInvalidDirectory;
    else {
        @autoreleasepool {
            if (!protectDirectory(canonical)) result = EFCRInstallInvalidDirectory;
            else {
                attempted = true;
                efcr_gateSet(false);
                KSCrashCConfiguration configuration = KSCrashCConfiguration_Default();
                configuration.monitors = KSCrashMonitorTypeMachException | KSCrashMonitorTypeSignal | KSCrashMonitorTypeNSException;
                configuration.reportStoreConfiguration.maxReportCount = 1;
                configuration.enableSwapCxaThrow = false;
                configuration.enableQueueNameSearch = false;
                configuration.enableMemoryIntrospection = false;
                configuration.enableCPUExceptionReporting = false;
                configuration.enableHangReporting = false;
                configuration.addConsoleLogToReport = false;
                configuration.printPreviousLogOnStartup = false;
                configuration.userInfoJSON = NULL;
                configuration.willWriteReportCallback = efcr_willWriteReport;
                installed = kscrash_install("Everframe", canonical, &configuration) == KSCrashInstallErrorNone;
                kscm_disableAllMonitors();
                result = installed ? EFCRInstallSuccess : EFCRInstallVendorFailure;
            }
        }
    }
    pthread_mutex_unlock(&installLock);
    return result;
}

bool EFCRSetEnabled(bool enabled) {
    pthread_mutex_lock(&installLock);
    bool success = installed;
    if (installed && enabled != efcr_gateGet()) {
        if (enabled) {
            success = kscm_enableMonitors();
            if (success) efcr_gateSet(true);
            else kscm_disableAllMonitors();
        } else {
            efcr_gateSet(false);
            kscm_disableAllMonitors();
        }
    }
    pthread_mutex_unlock(&installLock);
    return success;
}
bool EFCRIsEnabled(void) { return efcr_gateGet(); }
const char *EFCRVersion(void) { return "EverframeCrashRecorder/1 KSCrash/2.6.0 3f77f379c2db001e0c261c2a51b7e2b115d31f91"; }
