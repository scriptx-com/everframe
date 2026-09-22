// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Relay namespace barrel — re-exports the discriminated union plus each branch
// schema so consumers can both validate full RelayMessage frames and narrow
// against a specific branch (e.g. `relay.ReportSubmit.parse(...)`).
export {
  RelayMessage,
  PairCreated,
  PairBonded,
  PairExpired,
  PhoneDisconnected,
  AttachChallenge,
  AttachChallengeCleared,
  ReportRequest,
  ReportAssembled,
  ReportDraftUpdate,
  ReportSubmit,
  ReportCompleted,
  ReportFailed,
  ReportRejected,
  ReportCancelled,
  PreviewStart,
  PreviewStop,
  PreviewFrame,
  ShotRequest,
  ShotAssembled,
  ShotFailed,
  ShotBinary,
} from './messages.js';
