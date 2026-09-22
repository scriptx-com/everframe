// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Session-replay capture barrel. NOTE (REPLAY-05): this barrel must NOT statically
// import rrweb — the recorder's dynamic `import('rrweb')` is the only load path, so
// the always-loaded entrypoint stays at ~0 KB when replay is OFF.
export {
  createRollingBuffer,
  FULL_SNAPSHOT,
  MAX_BUFFER_BYTES,
  MAX_BUFFER_EVENTS,
  type BufferEvent,
  type RollingBuffer,
  type RollingBufferOptions,
} from './buffer.js';
export {
  buildRecordOptions,
  applyReplayMaskClasses,
  checkoutIntervalMs,
  clamp,
  RR_BLOCK_CLASS,
  RR_MASK_CLASS,
  MASK_PLACEHOLDER,
  type RrwebRecordOptions,
} from './mask-mapping.js';
export { scrubReplayEvents } from './scrub.js';
export {
  createReplayRecorder,
  type ReplayRecorder,
  type ReplayRecorderDeps,
  type ReplayRecorderDiagnostics,
} from './recorder.js';
