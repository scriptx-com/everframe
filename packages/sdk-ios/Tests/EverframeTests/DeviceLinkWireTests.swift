// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

final class DeviceLinkWireTests: XCTestCase {
    private func json(_ raw: String) -> Data { deviceLinkJSON(raw) }

    func testTokenPatternAcceptsOnlyDeviceTokens() {
        XCTAssertTrue(DeviceLinkToken.isValid(fixtureToken))
        let bad: [String?] = [
            nil, "", "evf_dev_" + String(repeating: "a", count: 31), fixtureToken + "a",
            "evf_cap_" + String(repeating: "a", count: 32), "evf_dev_" + String(repeating: "-", count: 32),
            "evf_dev_" + String(repeating: "é", count: 32), " " + fixtureToken,
        ]
        for value in bad {
            XCTAssertFalse(DeviceLinkToken.isValid(value))
        }
    }

    func testFingerprintIsStableSixteenHex() {
        let f = DeviceLinkToken.fingerprint(fixtureToken)
        XCTAssertEqual(f, DeviceLinkToken.fingerprint(fixtureToken))
        XCTAssertEqual(f.count, 16)
        XCTAssertTrue(f.allSatisfy { $0.isHexDigit && !$0.isUppercase })
        XCTAssertNotEqual(f, DeviceLinkToken.fingerprint(otherToken))
    }

    func testNonceIsThirtyTwoAlphanumerics() {
        let nonces = (0..<100).map { _ in DeviceLinkNonce.make() }
        XCTAssertTrue(nonces.allSatisfy { $0.count == 32 && $0.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) } })
        XCTAssertEqual(Set(nonces).count, 100)
    }

    func testHelloReplyDecoding() {
        let id = UUID()
        XCTAssertEqual(DeviceLinkHelloReply.decode(json(#"{"status":"none"}"#)), DeviceLinkHelloReply.none)
        XCTAssertEqual(DeviceLinkHelloReply.decode(json(#"{"status":"pending","attemptId":"\#(id)","number":47}"#)),
                       .pending(attemptId: id, number: 47))
        XCTAssertEqual(DeviceLinkHelloReply.decode(json(#"{"status":"pending","attemptId":"\#(id.uuidString.lowercased())","number":0}"#)),
                       .pending(attemptId: id, number: 0))
        XCTAssertNil(DeviceLinkHelloReply.decode(json(#"{"status":"pending","attemptId":"../x","number":47}"#)))
        XCTAssertNil(DeviceLinkHelloReply.decode(json(#"{"status":"pending","attemptId":"\#(id)","number":100}"#)))
        XCTAssertNil(DeviceLinkHelloReply.decode(json(#"{"status":"pending","attemptId":"\#(id)","number":-1}"#)))
        XCTAssertNil(DeviceLinkHelloReply.decode(json(#"{"status":"pending","attemptId":"\#(id)","number":4.5}"#)))
        XCTAssertNil(DeviceLinkHelloReply.decode(json(#"{"status":"pending","attemptId":"\#(id)","number":"47"}"#)))
        XCTAssertNil(DeviceLinkHelloReply.decode(json(#"{"status":"pending","number":47}"#)))
        XCTAssertNil(DeviceLinkHelloReply.decode(json(#"{"status":"maybe"}"#)))
        XCTAssertNil(DeviceLinkHelloReply.decode(json("garbage")))
        XCTAssertNil(DeviceLinkHelloReply.decode(json("[]")))
    }

    func testCheckReplyDecoding() {
        XCTAssertEqual(DeviceLinkCheckReply.decode(json(#"{"status":"pending"}"#)), .pending)
        XCTAssertEqual(DeviceLinkCheckReply.decode(json(#"{"status":"expired"}"#)), .expired)
        XCTAssertEqual(
            DeviceLinkCheckReply.decode(json(#"{"status":"linked","token":"\#(fixtureToken)","owner":{"kind":"user","name":"Aurimas"}}"#)),
            .linked(token: fixtureToken, owner: .user(name: "Aurimas")))
        XCTAssertEqual(
            DeviceLinkCheckReply.decode(json(#"{"status":"linked","token":"\#(fixtureToken)","owner":{"kind":"team"}}"#)),
            .linked(token: fixtureToken, owner: .team))
        XCTAssertNil(DeviceLinkCheckReply.decode(json(#"{"status":"linked","token":"evf_cap_x","owner":{"kind":"team"}}"#)))
        XCTAssertNil(DeviceLinkCheckReply.decode(json(#"{"status":"linked","token":"\#(fixtureToken)","owner":{"kind":"user","name":"  "}}"#)))
        XCTAssertNil(DeviceLinkCheckReply.decode(json(#"{"status":"linked","token":"\#(fixtureToken)"}"#)))
        XCTAssertNil(DeviceLinkCheckReply.decode(json(#"{"status":"linked","token":"\#(fixtureToken)","owner":{"kind":"robot"}}"#)))
        XCTAssertNil(DeviceLinkCheckReply.decode(json(#"{"status":"other"}"#)))
        XCTAssertNil(DeviceLinkCheckReply.decode(json("garbage")))
    }

    func testOwnerNameIsTrimmed() {
        XCTAssertEqual(
            DeviceLinkCheckReply.decode(json(#"{"status":"linked","token":"\#(fixtureToken)","owner":{"kind":"user","name":"  Aurimas \n"}}"#)),
            .linked(token: fixtureToken, owner: .user(name: "Aurimas")))
    }

    func testOwnerCodableRoundTrip() throws {
        for owner in [DeviceLinkOwner.user(name: "Aurimas"), .team] {
            let data = try JSONEncoder().encode(owner)
            XCTAssertEqual(try JSONDecoder().decode(DeviceLinkOwner.self, from: data), owner)
        }
        let team = try JSONSerialization.jsonObject(with: JSONEncoder().encode(DeviceLinkOwner.team)) as? [String: Any]
        XCTAssertEqual(team?["kind"] as? String, "team")
        XCTAssertThrowsError(try JSONDecoder().decode(DeviceLinkOwner.self, from: json(#"{"kind":"user"}"#)))
        XCTAssertThrowsError(try JSONDecoder().decode(DeviceLinkOwner.self, from: json(#"{"kind":"admin"}"#)))
    }

    func testIngestLinkPending() {
        let id = UUID()
        XCTAssertEqual(
            DeviceLinkPending.fromIngestBody(json(#"{"reportId":"r","linkPending":{"attemptId":"\#(id)","number":47}}"#)),
            DeviceLinkPending(attemptId: id, number: 47))
        XCTAssertNil(DeviceLinkPending.fromIngestBody(json(#"{"reportId":"r"}"#)))
        XCTAssertNil(DeviceLinkPending.fromIngestBody(json(#"{"reportId":"r","linkPending":{"attemptId":"\#(id)","number":"47"}}"#)))
        XCTAssertNil(DeviceLinkPending.fromIngestBody(json(#"{"reportId":"r","linkPending":{"attemptId":"x/y","number":47}}"#)))
        XCTAssertNil(DeviceLinkPending.fromIngestBody(json(#"{"reportId":"r","linkPending":{"attemptId":"\#(id)","number":120}}"#)))
        XCTAssertNil(DeviceLinkPending.fromIngestBody(Data()))
        XCTAssertNil(DeviceLinkPending.fromIngestBody(json("garbage")))
    }

    func testDeviceUnlinkedBody() {
        XCTAssertTrue(DeviceLinkRejection.isDeviceUnlinkedBody(json(#"{"error":"device_unlinked"}"#)))
        XCTAssertFalse(DeviceLinkRejection.isDeviceUnlinkedBody(json(#"{"error":"forbidden"}"#)))
        XCTAssertFalse(DeviceLinkRejection.isDeviceUnlinkedBody(json("garbage")))
        XCTAssertFalse(DeviceLinkRejection.isDeviceUnlinkedBody(Data()))
    }

    func testOwnerCopy() {
        XCTAssertEqual(DeviceLinkOwner.user(name: "Aurimas").capturedToastText, "Captured · Aurimas")
        XCTAssertEqual(DeviceLinkOwner.user(name: "Aurimas").linkedToastText, "Linked to Aurimas")
        XCTAssertEqual(DeviceLinkOwner.team.capturedToastText, "Captured · team device")
        XCTAssertEqual(DeviceLinkOwner.team.linkedToastText, "Linked as team device")
    }

    func testHostModeResolution() {
        XCTAssertEqual(QuickCaptureHostMode.resolve(isSimulator: false, isPhoneOS: true, environment: [:]), .device)
        XCTAssertEqual(QuickCaptureHostMode.resolve(isSimulator: true, isPhoneOS: true, environment: [:]), .simulator)
        XCTAssertEqual(QuickCaptureHostMode.resolve(isSimulator: true, isPhoneOS: true,
                                                    environment: ["EVERFRAME_SIMULATE_DEVICE": "1"]), .device)
        XCTAssertEqual(QuickCaptureHostMode.resolve(isSimulator: true, isPhoneOS: true,
                                                    environment: ["EVERFRAME_SIMULATE_DEVICE": "0"]), .simulator)
        // tvOS simulator
        XCTAssertEqual(QuickCaptureHostMode.resolve(isSimulator: true, isPhoneOS: false,
                                                    environment: ["EVERFRAME_SIMULATE_DEVICE": "1"]), .simulator)
        // tvOS device
        XCTAssertEqual(QuickCaptureHostMode.resolve(isSimulator: false, isPhoneOS: false, environment: [:]), .unsupported)
        // The switch is ignored on a real device.
        XCTAssertEqual(QuickCaptureHostMode.resolve(isSimulator: false, isPhoneOS: false,
                                                    environment: ["EVERFRAME_SIMULATE_DEVICE": "1"]), .unsupported)
    }

    func testHelloRequestEncodesContractKeys() throws {
        let request = DeviceLinkHelloRequest(
            attemptNonce: DeviceLinkNonce.make(),
            device: .init(model: "iPhone16,1", os: "iOS", osVersion: "18.2", appVersion: "1.0.0",
                          sdk: "ios/1.6.0", formFactor: "phone"))
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["attemptNonce", "device"])
        let device = try XCTUnwrap(object["device"] as? [String: Any])
        XCTAssertEqual(Set(device.keys), ["model", "os", "osVersion", "appVersion", "sdk", "formFactor"])
        XCTAssertEqual(device["formFactor"] as? String, "phone")
    }
}
