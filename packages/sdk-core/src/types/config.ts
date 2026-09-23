// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type { CustomRule } from "./redaction.js";

export interface UserMetadata {
  id?: string;
  email?: string;
  displayName?: string;
}

export interface RedactionConfig {
  maskInputs?: Array<"email" | "tel" | "creditcard" | "ssn">;
  allowProps?: string[];
  customRules?: CustomRule[];
}

export interface EverframeConfig {
  /**
   * Per-app SDK key (publishable, not secret). Mirrors the React Native SDK's
   * `apiKey` field so both SDKs share one config shape.
   */
  apiKey: string;
  /** Optional. */
  appName?: string;
  appVersion?: string;
  /** Exact deployed build identifier (for example a CI build ID or commit SHA). */
  appBuild?: string;
  /** Disable everything (DEFE-03). */
  disabled?: boolean;
  /** Surface SDK-internal errors to host app. */
  onError?: (err: EverframeError) => void;
  /** Redaction overrides. Defaults are default-deny. */
  redaction?: RedactionConfig;
  /**
   * Session-replay client controls. This is a CLIENT VETO only — it can turn
   * replay OFF locally but can NEVER force it ON. Server enablement
   * (`GET /api/config` → `replayEnabled`) is authoritative; effective
   * enablement is `serverEnabled && !sessionReplay?.disabled` (CONFIG-02).
   */
  sessionReplay?: {
    /** When true, the SDK never starts the replay buffer regardless of server config. */
    disabled?: boolean;
  };
  /**
   * Network body-capture client controls. CLIENT VETO only — turns capture OFF
   * locally; can NEVER force it ON. Server enablement
   * (`GET /api/config` → `networkBodies.captureBodies`) is authoritative
   * (spec 2026-07-18 §3).
   */
  networkBodies?: {
    /** When true, request/response bodies are never captured regardless of server config. */
    disabled?: boolean;
  };
  /**
   * Crash/error reporting client controls, including captureException().
   * ON by default — unlike networkBodies, the payload is data the SDK
   * already captures (exception + breadcrumb trail), fully redacted.
   * CLIENT VETO only: can turn capture OFF, never force anything ON.
   */
  crashReporting?: {
    /** When true, automatic errors and captureException() are not reported. */
    disabled?: boolean;
  };
  /**
   * Two-way replies client controls. Client veto only: can turn replies OFF
   * locally, can never force them ON — the server's per-app gate is
   * authoritative (same rule as sessionReplay/networkBodies above).
   */
  replies?: {
    /** 'headless': never render SDK reply UI; host consumes tx.threads.*. Default 'default'. */
    ui?: 'default' | 'headless';
    /** Automatic poll cadence; floored to 60s. */
    pollIntervalMs?: number;
    /** Hard local off-switch: no polling, no UI, no token presented on submit. */
    disabled?: boolean;
  };
  /**
   * Install-identifier client control (mai meter spec 2026-08-28). ON by
   * default: the SDK derives a value from a per-install seed and sends it at
   * most once a day, so we can count distinct installs toward your plan's
   * usage. The value is not shared across apps and nothing about the person
   * using the app is derived or stored. CLIENT VETO only — this can turn it
   * off locally, it can never force it on.
   */
  installIdentifier?: {
    /**
     * When true, the SDK stops sending an install identifier from THIS app,
     * from that point on.
     *
     * Finding 5 (2026-08-28 review): this is NOT retroactive and NOT
     * org-wide, so do not expect the displayed count to read zero just
     * because this is set. Installs already recorded earlier in the
     * calendar month stay counted until the monthly sweep drops that
     * period, and the count shown to you is per ORGANIZATION — any other
     * app in the same org that still sends an identifier keeps
     * contributing.
     */
    disabled?: boolean;
  };
  /** Verbose console logs. */
  debug?: boolean;
}

export interface EverframeError {
  name: string;
  message: string;
  stack?: string;
}
