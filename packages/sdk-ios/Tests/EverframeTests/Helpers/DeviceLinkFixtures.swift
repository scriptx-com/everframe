// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

/// Device-link test tokens. They match the token pattern and are never real.
let fixtureToken = "evf_dev_" + String(repeating: "a", count: 32)
let otherToken = "evf_dev_" + String(repeating: "b", count: 32)

func deviceLinkJSON(_ raw: String) -> Data { Data(raw.utf8) }
