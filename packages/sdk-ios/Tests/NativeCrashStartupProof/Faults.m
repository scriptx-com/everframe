// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#import <Foundation/Foundation.h>
#include <dlfcn.h>
#include <sys/mman.h>
#include <unistd.h>
#include "Faults.h"
// Observe readiness only. The host never installs, updates or recovers the
// recorder itself, and needs no recorder headers in the framework consumer.
bool NativeProofRecorderEnabled(void) {
    bool (*enabled)(void) = dlsym(RTLD_DEFAULT, "EFCRIsEnabled");
    return enabled != NULL && enabled();
}
void NativeProofObjCException(void) {
    @throw [NSException exceptionWithName:@"NativeStartupProof"
        reason:@"synthetic startup exception" userInfo:@{@"sensitive": @"native-proof-user-info-secret"}];
}
void NativeProofMemoryFault(void) {
    void *page = mmap(NULL, (size_t)getpagesize(), PROT_NONE, MAP_PRIVATE | MAP_ANON, -1, 0);
    if (page == MAP_FAILED) _exit(77);
    *(volatile char *)page = 1;
    _exit(78);
}

// URLSessionConfiguration.protocolClasses can replace the global URLProtocol
// registry. Put the loopback interceptor into every new default configuration
// before the SDK constructs its isolated upload session. Test host only.
static Class proofProtocolClass;
@implementation NSURLSessionConfiguration (NativeStartupLoopback)
+ (NSURLSessionConfiguration *)nativeProof_defaultSessionConfiguration {
    NSURLSessionConfiguration *configuration = [self nativeProof_defaultSessionConfiguration];
    configuration.protocolClasses = [@[proofProtocolClass] arrayByAddingObjectsFromArray:configuration.protocolClasses ?: @[]];
    return configuration;
}
@end
void NativeProofInstallTransport(Class protocolClass) {
    proofProtocolClass = protocolClass;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        method_exchangeImplementations(
            class_getClassMethod(NSURLSessionConfiguration.class, @selector(defaultSessionConfiguration)),
            class_getClassMethod(NSURLSessionConfiguration.class, @selector(nativeProof_defaultSessionConfiguration)));
    });
}
