// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type { SnAttributeValue, SnDocument, SnElement, SnNode, SnText } from '../../../src/capture/tv-snapshot/sn-types.js';

let nextId = 1;
export function resetIds(): void {
  nextId = 1;
}
export function el(
  tagName: string,
  attributes: Record<string, SnAttributeValue> = {},
  childNodes: SnNode[] = [],
  extra: Partial<Pick<SnElement, 'isSVG'>> = {},
): SnElement {
  return { type: 2, id: nextId++, tagName, attributes, childNodes, ...extra };
}
export function text(textContent: string): SnText {
  return { type: 3, id: nextId++, textContent };
}
export function doc(...childNodes: SnNode[]): SnDocument {
  return { type: 0, id: nextId++, childNodes };
}
/** First element in the tree matching `pred`. */
export function find(root: SnNode, pred: (e: SnElement) => boolean): SnElement | undefined {
  if (root.type === 2 && pred(root)) return root;
  if (root.type === 0 || root.type === 2) {
    for (const child of root.childNodes) {
      const hit = find(child, pred);
      if (hit) return hit;
    }
  }
  return undefined;
}
