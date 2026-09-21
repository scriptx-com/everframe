// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

/** Read capture/relay bytes on browsers predating Blob.arrayBuffer (e.g. webOS). */
export function readBlobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('Blob read failed'));
    reader.onabort = () => reject(new Error('Blob read aborted'));
    reader.readAsArrayBuffer(blob);
  });
}
