// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

/// Preserve pre-diagnostic initializer and copy symbols for existing callers.
public extension EverframePayload {
    init(annotations: [EverframeJSONAny]?, breadcrumbs: [EverframeBreadcrumb]?, crash: EverframeCrash?,
         extra: String?, focus: EverframeFocus?, logs: [EverframeJSONAny]?, network: [EverframeJSONAny]?,
         networkBodies: [EverframeNetworkBody]?, redactions: [EverframeJSONAny]?,
         resources: [EverframeResource]?, vitals: [EverframeVital]?) {
        self.init(annotations: annotations, breadcrumbs: breadcrumbs, crash: crash, diagnostic: nil,
                  extra: extra, focus: focus, logs: logs, network: network, networkBodies: networkBodies,
                  redactions: redactions, resources: resources, vitals: vitals)
    }

    func with(annotations: [EverframeJSONAny]?? = nil, breadcrumbs: [EverframeBreadcrumb]?? = nil,
              crash: EverframeCrash?? = nil, extra: String?? = nil, focus: EverframeFocus?? = nil,
              logs: [EverframeJSONAny]?? = nil, network: [EverframeJSONAny]?? = nil,
              networkBodies: [EverframeNetworkBody]?? = nil, redactions: [EverframeJSONAny]?? = nil,
              resources: [EverframeResource]?? = nil, vitals: [EverframeVital]?? = nil) -> EverframePayload {
        EverframePayload(annotations: annotations ?? self.annotations, breadcrumbs: breadcrumbs ?? self.breadcrumbs,
                         crash: crash ?? self.crash, diagnostic: self.diagnostic, extra: extra ?? self.extra,
                         focus: focus ?? self.focus, logs: logs ?? self.logs, network: network ?? self.network,
                         networkBodies: networkBodies ?? self.networkBodies, recoveredStall: self.recoveredStall, redactions: redactions ?? self.redactions,
                         resources: resources ?? self.resources, vitals: vitals ?? self.vitals)
    }
}

/// Preserve the prior OS-diagnostic Payload initializer/with ABI as well.
public extension EverframePayload {
    init(annotations: [EverframeJSONAny]?, breadcrumbs: [EverframeBreadcrumb]?, crash: EverframeCrash?,
         diagnostic: EverframeDiagnosticEvidence?, extra: String?, focus: EverframeFocus?,
         logs: [EverframeJSONAny]?, network: [EverframeJSONAny]?, networkBodies: [EverframeNetworkBody]?,
         redactions: [EverframeJSONAny]?, resources: [EverframeResource]?, vitals: [EverframeVital]?) {
        self.init(annotations: annotations, breadcrumbs: breadcrumbs, crash: crash, diagnostic: diagnostic,
                  extra: extra, focus: focus, logs: logs, network: network, networkBodies: networkBodies,
                  recoveredStall: nil, redactions: redactions, resources: resources, vitals: vitals)
    }

    func with(annotations: [EverframeJSONAny]?? = nil, breadcrumbs: [EverframeBreadcrumb]?? = nil,
              crash: EverframeCrash?? = nil, diagnostic: EverframeDiagnosticEvidence?? = nil,
              extra: String?? = nil, focus: EverframeFocus?? = nil, logs: [EverframeJSONAny]?? = nil,
              network: [EverframeJSONAny]?? = nil, networkBodies: [EverframeNetworkBody]?? = nil,
              redactions: [EverframeJSONAny]?? = nil, resources: [EverframeResource]?? = nil,
              vitals: [EverframeVital]?? = nil) -> EverframePayload {
        EverframePayload(annotations: annotations ?? self.annotations, breadcrumbs: breadcrumbs ?? self.breadcrumbs,
                         crash: crash ?? self.crash, diagnostic: diagnostic ?? self.diagnostic,
                         extra: extra ?? self.extra, focus: focus ?? self.focus, logs: logs ?? self.logs,
                         network: network ?? self.network, networkBodies: networkBodies ?? self.networkBodies,
                         recoveredStall: self.recoveredStall, redactions: redactions ?? self.redactions,
                         resources: resources ?? self.resources, vitals: vitals ?? self.vitals)
    }
}
