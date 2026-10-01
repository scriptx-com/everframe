// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Feature-detect gzip path: native CompressionStream on web/Node 18+, fflate fallback
// on older Hermes (Pitfall 3 in RESEARCH.md — older Hermes does not implement
// CompressionStream).
export async function gzipBytes(input: Uint8Array): Promise<Uint8Array> {
  // A bare `typeof` — never `globalThis.…`, a ReferenceError on Chrome < 71 TVs.
  if (typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream('gzip');
    const stream = new Blob([input as BlobPart]).stream().pipeThrough(cs);
    const arrayBuffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }
  const { gzipSync } = await import('fflate');
  return gzipSync(input);
}
