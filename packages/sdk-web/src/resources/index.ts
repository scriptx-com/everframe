// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Report Resource Window (spec 2026-09-05) — barrel for the ring + sampler
// so adapter.ts (Task 9) has one import surface.
export { createResourceRing } from './ring.js';
export type { ResourceRing, ResourceRingDeps } from './ring.js';
export { startResourceSampler } from './sampler.js';
export type { ResourceSamplerDeps } from './sampler.js';
export { stampResources, __setActiveResources, __getActiveResources } from './stamp.js';
export type { ActiveResourcesBox } from './stamp.js';
