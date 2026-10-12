// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { FULL_SNAPSHOT, META, type BufferEvent } from './buffer.js';

type Node = { id: number; type: number; childNodes?: Node[]; attributes?: Record<string, unknown>; textContent?: string; [key: string]: unknown };
type Mutation = { source: number; texts?: Array<{ id: number; value: string }>; attributes?: Array<{ id: number; attributes: Record<string, unknown> }>;
  removes?: Array<{ parentId: number; id: number }>; adds?: Array<{ parentId: number; nextId: number | null; node: Node }> };

export class ReplayCheckpointOmitted extends Error {
  constructor() { super('Unsupported replay checkpoint state'); }
}

/** Reconstruct the starting DOM from recorded data only, never today's live DOM. */
export function checkpointWindow(events: BufferEvent[], start: number): BufferEvent[] {
  const anchorIndex = events.findIndex(event => event.type === FULL_SNAPSHOT);
  if (anchorIndex < 0 || events[anchorIndex]!.timestamp > start) return events;
  const anchor = JSON.parse(JSON.stringify(events[anchorIndex])) as BufferEvent;
  const data = anchor.data as { node?: Node; initialOffset?: { top: number; left: number } };
  if (!data.node) return events.map(event => event.timestamp < start ? { ...event, timestamp: start } : event);
  const nodes = new Map<number, Node>();
  function index(root: Node): void {
    const pending = [root];
    while (pending.length) { const node = pending.pop()!; nodes.set(node.id, node); pending.push(...(node.childNodes ?? [])); }
  }
  index(data.node);
  const prelude: BufferEvent[] = [];
  let viewport: { width: number; height: number } | undefined;
  let next = anchorIndex + 1;
  for (; next < events.length && events[next]!.timestamp <= start; next++) {
    const event = events[next]!;
    if (event.type !== 3) { prelude.push({ ...event, timestamp: start }); continue; }
    const change = event.data as Mutation;
    if (change.source === undefined) throw new ReplayCheckpointOmitted();
    if (change.source === 0) {
      if ('isAttachIframe' in change) throw new ReplayCheckpointOmitted();
      for (const remove of change.removes ?? []) {
        const parent = nodes.get(remove.parentId);
        if (parent?.childNodes) {
          const removed = parent.childNodes.find(node => node.id === remove.id);
          parent.childNodes = parent.childNodes.filter(node => node.id !== remove.id);
          const pending = removed ? [removed] : [];
          while (pending.length) { const node = pending.pop()!; nodes.delete(node.id); pending.push(...(node.childNodes ?? [])); }
        }
      }
      // rrweb can send children before their newly-added parent. Resolve the
      // bounded batch until no additional parent is available.
      let adds = [...(change.adds ?? [])];
      while (adds.length) {
        const remaining: typeof adds = [];
        for (const add of adds) {
          if ('isShadow' in add.node || 'isAttachIframe' in change || 'isShadow' in add || 'isAttachIframe' in add) throw new ReplayCheckpointOmitted();
          const parent = nodes.get(add.parentId);
          if (!parent || (add.nextId !== null && !parent.childNodes?.some(node => node.id === add.nextId))) { remaining.push(add); continue; }
          const node = JSON.parse(JSON.stringify(add.node)) as Node;
          const children = parent.childNodes ?? (parent.childNodes = []);
          const before = children.findIndex(child => child.id === add.nextId);
          children.splice(before < 0 ? children.length : before, 0, node);
          index(node);
        }
        if (remaining.length === adds.length) throw new ReplayCheckpointOmitted();
        adds = remaining;
      }
      for (const text of change.texts ?? []) { const node = nodes.get(text.id); if (node) node.textContent = text.value; }
      for (const attr of change.attributes ?? []) {
        const node = nodes.get(attr.id);
        if (!node) continue;
        const attributes = node.attributes ?? (node.attributes = {});
        for (const [key, value] of Object.entries(attr.attributes)) {
          if (typeof value === 'object' && value !== null) throw new ReplayCheckpointOmitted();
          if (value === null) delete attributes[key]; else attributes[key] = value;
        }
      }
    } else if (change.source === 3) {
      const scroll = event.data as { id: number; x: number; y: number };
      const node = nodes.get(scroll.id);
      if (node?.type === 0) data.initialOffset = { left: scroll.x, top: scroll.y };
      else if (node) Object.assign(node.attributes ?? (node.attributes = {}), { rr_scrollLeft: scroll.x, rr_scrollTop: scroll.y });
    } else if (change.source === 5) {
      const input = event.data as { id: number; text: string };
      const node = nodes.get(input.id);
      if (node) (node.attributes ?? (node.attributes = {})).value = '***';
    } else if (change.source === 4) {
      viewport = event.data as { width: number; height: number };
    } else if ([1, 2, 6, 12].includes(change.source)) {
      // Non-DOM events retain their original ordering at the start. Form
      // values are masked by capture and scrub; their event data stays intact.
      prelude.push({ ...event, timestamp: start });
    } else {
      // CSSOM, media and adopted styles need their native replay engine. An
      // optional error snapshot must omit rather than reconstruct them wrongly.
      throw new ReplayCheckpointOmitted();
    }
  }
  anchor.timestamp = start;
  const meta = anchorIndex > 0 && events[anchorIndex - 1]!.type === META
    ? [{ ...events[anchorIndex - 1]!, timestamp: start, data: { ...(events[anchorIndex - 1]!.data as object), ...(viewport ? { width: viewport.width, height: viewport.height } : {}) } }] : [];
  return [...meta, anchor, ...prelude, ...events.slice(next)];
}
