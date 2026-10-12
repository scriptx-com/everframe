// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.compat.exposure;
import dev.everframe.config.EverframeConfig;
import dev.everframe.protocol.generated.DiagnosticEvidence;
public final class OldJavaConstructors {
    public static DiagnosticEvidence diagnostic(DiagnosticEvidence v) {
        return new DiagnosticEvidence(v.getAndroid(), v.getAttribution(), v.getCause(), v.getCollectedAt(),
            v.getEvidenceID(), v.getKind(), v.getOccurredAt(), v.getOutcome(), v.getProcessLaunchID(),
            v.getProvenance(), v.getScope(), v.getTrace(), v.getVersion());
    }
    public static EverframeConfig config(EverframeConfig v) {
        return new EverframeConfig(v.getAppId(), v.getSdkKey(), v.getEnvironment(), v.getRelease(), v.getCapture(),
            v.getBubble(), v.getUseDynamicColor(), v.getCompanionDeviceId(), v.getCompanionBadgeEnabled(),
            v.getShakeToReportEnabled(), v.getCompanionBadgePosition(), v.getTheme(), v.getInstallIdentifierEnabled(),
            v.getVitals(), v.getR8MappingId());
    }
}
