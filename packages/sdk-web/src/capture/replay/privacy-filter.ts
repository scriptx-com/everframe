// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type { BufferEvent } from './buffer.js';
import { SENSITIVE_ATTR } from '../../sensitive/registry.js';

export interface ReplayNodeMirror { getNode(id: number): Node | null }

/** rrweb's immediate-parent mutation checks do not cross shadow boundaries. */
export function filterReplayEvent(event: BufferEvent, mirror: ReplayNodeMirror): BufferEvent | undefined {
  const resolve = (id: number): Node | null => {
    try { return mirror.getNode(id); } catch { return null; }
  };
  const sensitive = (node: Node | null): boolean => {
    while (node) {
      if (node.nodeType === 1) {
        const element = node as Element;
        if (element.hasAttribute(SENSITIVE_ATTR) || element.classList.contains('rr-block')) return true;
      }
      node = node.parentNode ?? (node.nodeType === 11 ? (node as ShadowRoot).host : null);
    }
    return false;
  };
  const safeId = (id: number): boolean => {
    const node = resolve(id);
    return node !== null && !sensitive(node);
  };
  // Custom/plugin payloads have no trustworthy DOM ancestry. The recorder's
  // own timeline endpoint is added separately, after capture, without content.
  if (event.type === 5 || event.type === 6) return undefined;
  if (event.type !== 3 || !event.data || typeof event.data !== 'object') return event;
  const data = event.data as { source: number; id?: number; positions?: Array<{ id: number }>;
    texts?: Array<{ id: number }>; attributes?: Array<{ id: number }>;
    adds?: Array<{ parentId: number; node: { id: number } }> };
  if (data.source === 0) {
    return { ...event, data: { ...data,
      texts: data.texts?.filter(text => safeId(text.id)),
      attributes: data.attributes?.filter(attr => safeId(attr.id)),
      adds: data.adds?.filter(add => safeId(add.node.id) && !sensitive(resolve(add.parentId))),
      // Keep removals: an old public subtree may still need to disappear.
    } };
  }
  if (typeof data.id === 'number' && !safeId(data.id)) return undefined;
  if (data.positions) {
    const positions = data.positions.filter(position => safeId(position.id));
    // rrweb seek requires a last position; an empty batch is not replayable.
    return positions.length ? { ...event, data: { ...data, positions } } : undefined;
  }
  return event;
}
