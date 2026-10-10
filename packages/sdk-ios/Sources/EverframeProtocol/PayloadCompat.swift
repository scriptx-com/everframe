// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

public extension EverframePayload {
    init(annotations: [EverframeJSONAny]?,
         breadcrumbs: [EverframeBreadcrumb]?,
         crash: EverframeCrash?,
         extra: String?,
         focus: EverframeFocus?,
         logs: [EverframeJSONAny]?,
         network: [EverframeJSONAny]?,
         networkBodies: [EverframeNetworkBody]?,
         redactions: [EverframeJSONAny]?,
         resources: [EverframeResource]?,
         vitals: [EverframeVital]?) {
        self.init(annotations: annotations, appleDiagnostic: nil, breadcrumbs: breadcrumbs, crash: crash, diagnostic: nil, extra: extra, focus: focus, inferredTermination: nil, logs: logs, network: network, networkBodies: networkBodies, recoveredStall: nil, redactions: redactions, resources: resources, vitals: vitals)
    }

    func with(annotations: [EverframeJSONAny]?? = nil,
              breadcrumbs: [EverframeBreadcrumb]?? = nil,
              crash: EverframeCrash?? = nil,
              extra: String?? = nil,
              focus: EverframeFocus?? = nil,
              logs: [EverframeJSONAny]?? = nil,
              network: [EverframeJSONAny]?? = nil,
              networkBodies: [EverframeNetworkBody]?? = nil,
              redactions: [EverframeJSONAny]?? = nil,
              resources: [EverframeResource]?? = nil,
              vitals: [EverframeVital]?? = nil) -> EverframePayload {
        EverframePayload(annotations: annotations ?? self.annotations, appleDiagnostic: self.appleDiagnostic, breadcrumbs: breadcrumbs ?? self.breadcrumbs, crash: crash ?? self.crash, diagnostic: self.diagnostic, extra: extra ?? self.extra, focus: focus ?? self.focus, inferredTermination: self.inferredTermination, logs: logs ?? self.logs, network: network ?? self.network, networkBodies: networkBodies ?? self.networkBodies, recoveredStall: self.recoveredStall, redactions: redactions ?? self.redactions, resources: resources ?? self.resources, vitals: vitals ?? self.vitals)
    }
}

public extension EverframePayload {
    init(annotations: [EverframeJSONAny]?,
         breadcrumbs: [EverframeBreadcrumb]?,
         crash: EverframeCrash?,
         diagnostic: EverframeDiagnosticEvidence?,
         extra: String?,
         focus: EverframeFocus?,
         logs: [EverframeJSONAny]?,
         network: [EverframeJSONAny]?,
         networkBodies: [EverframeNetworkBody]?,
         redactions: [EverframeJSONAny]?,
         resources: [EverframeResource]?,
         vitals: [EverframeVital]?) {
        self.init(annotations: annotations, appleDiagnostic: nil, breadcrumbs: breadcrumbs, crash: crash, diagnostic: diagnostic, extra: extra, focus: focus, inferredTermination: nil, logs: logs, network: network, networkBodies: networkBodies, recoveredStall: nil, redactions: redactions, resources: resources, vitals: vitals)
    }

    func with(annotations: [EverframeJSONAny]?? = nil,
              breadcrumbs: [EverframeBreadcrumb]?? = nil,
              crash: EverframeCrash?? = nil,
              diagnostic: EverframeDiagnosticEvidence?? = nil,
              extra: String?? = nil,
              focus: EverframeFocus?? = nil,
              logs: [EverframeJSONAny]?? = nil,
              network: [EverframeJSONAny]?? = nil,
              networkBodies: [EverframeNetworkBody]?? = nil,
              redactions: [EverframeJSONAny]?? = nil,
              resources: [EverframeResource]?? = nil,
              vitals: [EverframeVital]?? = nil) -> EverframePayload {
        EverframePayload(annotations: annotations ?? self.annotations, appleDiagnostic: self.appleDiagnostic, breadcrumbs: breadcrumbs ?? self.breadcrumbs, crash: crash ?? self.crash, diagnostic: diagnostic ?? self.diagnostic, extra: extra ?? self.extra, focus: focus ?? self.focus, inferredTermination: self.inferredTermination, logs: logs ?? self.logs, network: network ?? self.network, networkBodies: networkBodies ?? self.networkBodies, recoveredStall: self.recoveredStall, redactions: redactions ?? self.redactions, resources: resources ?? self.resources, vitals: vitals ?? self.vitals)
    }
}

public extension EverframePayload {
    init(annotations: [EverframeJSONAny]?,
         appleDiagnostic: EverframeAppleDiagnosticEvidence?,
         breadcrumbs: [EverframeBreadcrumb]?,
         crash: EverframeCrash?,
         diagnostic: EverframeDiagnosticEvidence?,
         extra: String?,
         focus: EverframeFocus?,
         logs: [EverframeJSONAny]?,
         network: [EverframeJSONAny]?,
         networkBodies: [EverframeNetworkBody]?,
         redactions: [EverframeJSONAny]?,
         resources: [EverframeResource]?,
         vitals: [EverframeVital]?) {
        self.init(annotations: annotations, appleDiagnostic: appleDiagnostic, breadcrumbs: breadcrumbs, crash: crash, diagnostic: diagnostic, extra: extra, focus: focus, inferredTermination: nil, logs: logs, network: network, networkBodies: networkBodies, recoveredStall: nil, redactions: redactions, resources: resources, vitals: vitals)
    }

    func with(annotations: [EverframeJSONAny]?? = nil,
              appleDiagnostic: EverframeAppleDiagnosticEvidence?? = nil,
              breadcrumbs: [EverframeBreadcrumb]?? = nil,
              crash: EverframeCrash?? = nil,
              diagnostic: EverframeDiagnosticEvidence?? = nil,
              extra: String?? = nil,
              focus: EverframeFocus?? = nil,
              logs: [EverframeJSONAny]?? = nil,
              network: [EverframeJSONAny]?? = nil,
              networkBodies: [EverframeNetworkBody]?? = nil,
              redactions: [EverframeJSONAny]?? = nil,
              resources: [EverframeResource]?? = nil,
              vitals: [EverframeVital]?? = nil) -> EverframePayload {
        EverframePayload(annotations: annotations ?? self.annotations, appleDiagnostic: appleDiagnostic ?? self.appleDiagnostic, breadcrumbs: breadcrumbs ?? self.breadcrumbs, crash: crash ?? self.crash, diagnostic: diagnostic ?? self.diagnostic, extra: extra ?? self.extra, focus: focus ?? self.focus, inferredTermination: self.inferredTermination, logs: logs ?? self.logs, network: network ?? self.network, networkBodies: networkBodies ?? self.networkBodies, recoveredStall: self.recoveredStall, redactions: redactions ?? self.redactions, resources: resources ?? self.resources, vitals: vitals ?? self.vitals)
    }
}

public extension EverframePayload {
    init(annotations: [EverframeJSONAny]?,
         breadcrumbs: [EverframeBreadcrumb]?,
         crash: EverframeCrash?,
         diagnostic: EverframeDiagnosticEvidence?,
         extra: String?,
         focus: EverframeFocus?,
         logs: [EverframeJSONAny]?,
         network: [EverframeJSONAny]?,
         networkBodies: [EverframeNetworkBody]?,
         recoveredStall: EverframeRecoveredStallEvidence?,
         redactions: [EverframeJSONAny]?,
         resources: [EverframeResource]?,
         vitals: [EverframeVital]?) {
        self.init(annotations: annotations, appleDiagnostic: nil, breadcrumbs: breadcrumbs, crash: crash, diagnostic: diagnostic, extra: extra, focus: focus, inferredTermination: nil, logs: logs, network: network, networkBodies: networkBodies, recoveredStall: recoveredStall, redactions: redactions, resources: resources, vitals: vitals)
    }

    func with(annotations: [EverframeJSONAny]?? = nil,
              breadcrumbs: [EverframeBreadcrumb]?? = nil,
              crash: EverframeCrash?? = nil,
              diagnostic: EverframeDiagnosticEvidence?? = nil,
              extra: String?? = nil,
              focus: EverframeFocus?? = nil,
              logs: [EverframeJSONAny]?? = nil,
              network: [EverframeJSONAny]?? = nil,
              networkBodies: [EverframeNetworkBody]?? = nil,
              recoveredStall: EverframeRecoveredStallEvidence?? = nil,
              redactions: [EverframeJSONAny]?? = nil,
              resources: [EverframeResource]?? = nil,
              vitals: [EverframeVital]?? = nil) -> EverframePayload {
        EverframePayload(annotations: annotations ?? self.annotations, appleDiagnostic: self.appleDiagnostic, breadcrumbs: breadcrumbs ?? self.breadcrumbs, crash: crash ?? self.crash, diagnostic: diagnostic ?? self.diagnostic, extra: extra ?? self.extra, focus: focus ?? self.focus, inferredTermination: self.inferredTermination, logs: logs ?? self.logs, network: network ?? self.network, networkBodies: networkBodies ?? self.networkBodies, recoveredStall: recoveredStall ?? self.recoveredStall, redactions: redactions ?? self.redactions, resources: resources ?? self.resources, vitals: vitals ?? self.vitals)
    }
}

public extension EverframePayload {
    /// Preserve the memberwise initializer used before inferred terminations were added.
    init(annotations: [EverframeJSONAny]?,
         appleDiagnostic: EverframeAppleDiagnosticEvidence?,
         breadcrumbs: [EverframeBreadcrumb]?,
         crash: EverframeCrash?,
         diagnostic: EverframeDiagnosticEvidence?,
         extra: String?,
         focus: EverframeFocus?,
         logs: [EverframeJSONAny]?,
         network: [EverframeJSONAny]?,
         networkBodies: [EverframeNetworkBody]?,
         recoveredStall: EverframeRecoveredStallEvidence?,
         redactions: [EverframeJSONAny]?,
         resources: [EverframeResource]?,
         vitals: [EverframeVital]?) {
        self.init(annotations: annotations, appleDiagnostic: appleDiagnostic, breadcrumbs: breadcrumbs, crash: crash, diagnostic: diagnostic, extra: extra, focus: focus, inferredTermination: nil, logs: logs, network: network, networkBodies: networkBodies, recoveredStall: recoveredStall, redactions: redactions, resources: resources, vitals: vitals)
    }
}
