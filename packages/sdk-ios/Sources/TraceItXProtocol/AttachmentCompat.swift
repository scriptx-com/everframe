// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
public extension Attachment {
    init(byteLength: Double, contentType: String, durationMS: Double?, format: Format?,
         height: Double?, kind: AttachmentKind, partName: String, sha256: String, width: Double?) {
        self.init(byteLength: byteLength, contentType: contentType, durationMS: durationMS,
                  format: format, height: height, kind: kind, partName: partName,
                  replayStartEpochMS: nil, sha256: sha256, width: width)
    }
}
