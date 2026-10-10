// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
#if os(iOS) && canImport(MetricKit)
import MetricKit

/// This adapter only consumes OS-vended properties. It neither manufactures
/// incident times from intervals nor handles MetricKit crash diagnostics.
private final class AppleMetricKitAdapter: NSObject, MXMetricManagerSubscriber, @unchecked Sendable {
    private weak var runtime: AppleDiagnosticRuntime?
    private var subscribed = false // Runtime worker owns subscription changes.
    init(runtime: AppleDiagnosticRuntime) { self.runtime = runtime }
    func enabled(_ value: Bool) {
        guard subscribed != value else { return }; subscribed = value
        if value { MXMetricManager.shared.add(self) } else { MXMetricManager.shared.remove(self) }
    }
    private final class DiagnosticBatch: @unchecked Sendable {
        let values: [MXDiagnosticPayload]
        init(_ values: [MXDiagnosticPayload]) { self.values = AppleDiagnosticCallback.newest(values, end: { $0.timeStampEnd }) }
    }
    private final class MetricBatch: @unchecked Sendable {
        let values: [MXMetricPayload]
        init(_ values: [MXMetricPayload]) { self.values = AppleDiagnosticCallback.newest(values, end: { $0.timeStampEnd }) }
    }
    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        let batch = DiagnosticBatch(payloads)
        runtime?.receive(kind: .diagnostic) { batch.values.compactMap(Self.hangs) }
    }
    func didReceive(_ payloads: [MXMetricPayload]) {
        let batch = MetricBatch(payloads)
        runtime?.receive(kind: .metric) { batch.values.compactMap(Self.exits) }
    }
    private static func hangs(_ payload: MXDiagnosticPayload) -> AppleDiagnosticCandidate? {
        guard let all = payload.hangDiagnostics, let first = all.first else { return nil }
        let diagnostics = Array(all.prefix(8))
        guard diagnostics.allSatisfy({ $0.applicationVersion == first.applicationVersion
            && $0.metaData.applicationBuildVersion == first.metaData.applicationBuildVersion
            && $0.metaData.osVersion == first.metaData.osVersion }) else { return nil }
        let hangs = diagnostics.map {
            AppleDiagnosticHang(durationMs: $0.hangDuration.converted(to: .milliseconds).value,
                stack: AppleDiagnosticProjection.stack($0.callStackTree.jsonRepresentation()))
        }
        return .init(kind: "hang_batch", begin: payload.timeStampBegin, end: payload.timeStampEnd,
            applicationVersion: first.applicationVersion, applicationBuild: first.metaData.applicationBuildVersion,
            osVersion: first.metaData.osVersion, hangs: hangs, exits: [], truncated: all.count > 8)
    }
    private static func exits(_ payload: MXMetricPayload) -> AppleDiagnosticCandidate? {
        guard !payload.includesMultipleApplicationVersions, let metadata = payload.metaData,
              let metric = payload.applicationExitMetrics else { return nil }
        let foreground = metric.foregroundExitData, background = metric.backgroundExitData
        let values: [(String, String, Int)] = [
            ("foreground", "normal", foreground.cumulativeNormalAppExitCount),
            ("foreground", "memory_resource_limit", foreground.cumulativeMemoryResourceLimitExitCount),
            ("foreground", "bad_access", foreground.cumulativeBadAccessExitCount),
            ("foreground", "abnormal", foreground.cumulativeAbnormalExitCount),
            ("foreground", "illegal_instruction", foreground.cumulativeIllegalInstructionExitCount),
            ("foreground", "watchdog", foreground.cumulativeAppWatchdogExitCount),
            ("background", "normal", background.cumulativeNormalAppExitCount),
            ("background", "memory_resource_limit", background.cumulativeMemoryResourceLimitExitCount),
            ("background", "bad_access", background.cumulativeBadAccessExitCount),
            ("background", "abnormal", background.cumulativeAbnormalExitCount),
            ("background", "illegal_instruction", background.cumulativeIllegalInstructionExitCount),
            ("background", "watchdog", background.cumulativeAppWatchdogExitCount),
            ("background", "cpu_resource_limit", background.cumulativeCPUResourceLimitExitCount),
            ("background", "memory_pressure", background.cumulativeMemoryPressureExitCount),
            ("background", "suspended_locked_file", background.cumulativeSuspendedWithLockedFileExitCount),
            ("background", "background_task_timeout", background.cumulativeBackgroundTaskAssertionTimeoutExitCount),
        ]
        guard values.allSatisfy({ $0.2 >= 0 && $0.2 <= 2147483647 }) else { return nil }
        let exits = values.filter { $0.2 > 0 }.map { AppleDiagnosticExit(state: $0.0, reason: $0.1, count: $0.2) }
        guard !exits.isEmpty else { return nil }
        return .init(kind: "app_exit_summary", begin: payload.timeStampBegin, end: payload.timeStampEnd,
            applicationVersion: payload.latestApplicationVersion, applicationBuild: metadata.applicationBuildVersion,
            osVersion: metadata.osVersion, hangs: [], exits: exits, truncated: false)
    }
}
#endif

enum AppleDiagnosticPlatform {
    static func makeRuntime() -> AppleDiagnosticRuntime? {
        #if os(iOS) && canImport(MetricKit)
        let outbox = JSONLOutbox()
        let base = outbox.resolvedFileURL.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
            let runtime = AppleDiagnosticRuntime(root: base.appendingPathComponent("apple-diagnostics"), outbox: outbox)
            let adapter = AppleMetricKitAdapter(runtime: runtime)
            runtime.setDriver { adapter.enabled($0) }
            return runtime
        } catch { return nil }
        #else
        return nil
        #endif
    }
}

/// Keep only the eight newest periods without retaining an additional unbounded
/// array. Equal timestamps preserve OS order.
enum AppleDiagnosticCallback {
    enum Kind: Hashable { case diagnostic, metric }
    static func newest<T>(_ values: [T], end: (T) -> Date) -> [T] {
        var selected: [T] = []
        for value in values {
            let index = selected.firstIndex { end($0) < end(value) } ?? selected.count
            if index < 8 { selected.insert(value, at: index) }
            if selected.count > 8 { selected.removeLast() }
        }
        return selected
    }
}
