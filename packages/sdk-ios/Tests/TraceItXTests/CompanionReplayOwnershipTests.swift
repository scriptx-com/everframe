// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import Foundation
import UIKit
import Testing
import TraceItXProtocol
@testable import TraceItXKit

@MainActor @Suite(.serialized)
struct CompanionReplayOwnershipTests {
    private func waitForCapture(_ authorization: @MainActor () -> Bool) async -> Bool {
        for _ in 0..<500 {
            if authorization() { return true }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return authorization()
    }

    @Test(arguments: ["beforePreparation", "beforeTransport", "replacement"], [200, 503])
    func receivedReportSurvivesDisconnectWithoutConsumingNewCapture(timing: String, status: Int) async throws {
        try await withGlobalCaptureStateLock {
            try TraceItX.shared.start(config: TraceItXConfig(
                appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU", capture: CaptureConfig(logs: false)))
            let image = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).image { context in
                UIColor.black.setFill(); context.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
            }
            var inputs = ReporterSubmission.Inputs(
                captureResult: .init(image: image, widthPoints: 2, heightPoints: 2, scale: 1, pngData: image.pngData()!),
                shots: [.init(image: image, annotated: false)], title: "old", description: "",
                includeLogs: false, includeNetwork: false, includeMetadata: false,
                extraOverrides: [:], hostExtra: nil, capturedSession: TraceItX.shared.captureSessionSnapshot())
            let api = CompanionAPI()
            let client = RelayWSClient(companion: api)
            let bridge = CompanionCaptureBridge(client: client)
            defer {
                client.disconnect()
                CompanionCaptureBridge.abortReportCaptureLifecycle()
                withExtendedLifetime(bridge) {}
            }
            let correlation = UUID().uuidString
            client.handleControl(#"{"type":"pair.bonded","pair_id":"p"}"#)
            client.handleControl("{\"type\":\"report.request\",\"correlation_id\":\"\(correlation)\"}")
            inputs.captureIsCurrent = bridge.captureAuthorization(correlationId: correlation, authEpoch: CompanionAuthEpoch.current)
            #expect(await waitForCapture(inputs.captureIsCurrent))
            let disconnect = {
                client.handleControl(#"{"type":"phone.disconnected","pair_id":"p"}"#)
            }
            if timing != "beforeTransport" { disconnect() }
            if timing == "replacement" {
                let nextCorrelation = UUID().uuidString
                client.handleControl(#"{"type":"pair.bonded","pair_id":"next"}"#)
                client.handleControl("{\"type\":\"report.request\",\"correlation_id\":\"\(nextCorrelation)\"}")
                #expect(await waitForCapture(bridge.captureAuthorization(correlationId: nextCorrelation, authEpoch: CompanionAuthEpoch.current)))
            }
            RecordingURLProtocol.reset()
            RecordingURLProtocol.responseStatus = status
            let outboxURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            let outbox = JSONLOutbox(fileURL: outboxURL, keyProvider: { Data(repeating: 7, count: 32) })
            ReporterSubmission.__submitterFactoryForTesting = { config in
                if timing == "beforeTransport" { disconnect() }
                let configuration = URLSessionConfiguration.ephemeral
                configuration.protocolClasses = [RecordingURLProtocol.self]
                return ReportSubmitter(config: config, outbox: outbox,
                    session: URLSession(configuration: configuration))
            }
            defer {
                ReporterSubmission.__resetSubmitterFactoryForTesting()
                RecordingURLProtocol.reset()
                try? FileManager.default.removeItem(at: outboxURL)
            }
            if timing == "replacement" {
                BreadcrumbRingBuffer.shared.applyConfig(nil)
                BreadcrumbRingBuffer.shared.clear()
                BreadcrumbRingBuffer.shared.add(kind: .custom, message: "live-report", data: [:])
                BreadcrumbRingBuffer.shared.freeze()
                NetworkBodyRingBuffer.shared.clear()
                NetworkBodyRingBuffer.shared.append(NetworkBody(ref: 7, reqBody: "new-report-body", reqBodyBytes: 15,
                    reqBodySkipped: nil, reqBodyTruncated: nil, reqHeaders: nil,
                    resBody: nil, resBodyBytes: nil, resBodySkipped: nil, resBodyTruncated: nil, resHeaders: nil, t: 1))
                NetworkBodyRingBuffer.shared.freeze()
            }
            let result = try await ReporterSubmission.submit(inputs)
            switch result {
            case .submitted: #expect(status == 200)
            case .queued: #expect(status == 503)
            case .cancelled: Issue.record("A fully received report was cancelled on pair loss")
            }
            #expect(RecordingURLProtocol.recorded.count == 1)
            let queued = try outbox.hydrate()
            #expect(queued.count == (status == 503 ? 1 : 0))
            if let entry = queued.first {
                let envelope = try #require(JSONSerialization.jsonObject(with: entry.envelopeBytes) as? [String: Any])
                #expect((envelope["reporter"] as? [String: Any])?["title"] as? String == "old")
                #expect(entry.attachmentRefs.contains { $0.contentType == "image/png" })
                #expect(!entry.attachmentRefs.contains { $0.name == "replay" })
                #expect(!String(decoding: entry.envelopeBytes, as: UTF8.self).contains("live-report"))
                #expect(!String(decoding: entry.envelopeBytes, as: UTF8.self).contains("new-report-body"))
            }
            if timing == "replacement" {
                #expect(BreadcrumbRingBuffer.shared.takeFrozen()?.contains { $0.message == "live-report" } == true)
                #expect(NetworkBodyRingBuffer.shared.takeFrozen()?.first?.reqBody == "new-report-body")
                #expect(CompanionCaptureBridge.hasActiveReportCapture)
            }
        }
    }

    @Test func disconnectDropsCapturedScreenshotsBeforeAnotherReportCanSubmitThem() {
        let api = CompanionAPI()
        let client = RelayWSClient(companion: api)
        let bridge = CompanionCaptureBridge(client: client)
        bridge.__seedStashForTesting(correlationId: "old", hostExtra: "old report")
        #expect(bridge.__stashCountForTesting() == 1)
        client.handleControl(#"{"type":"phone.disconnected","pair_id":"p"}"#)
        #expect(bridge.__stashCountForTesting() == 0)
        withExtendedLifetime(bridge) {}
    }
}
#endif
