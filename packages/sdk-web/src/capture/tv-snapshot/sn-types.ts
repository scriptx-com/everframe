// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Structural types for rrweb-snapshot's serialized nodes — declared locally so
// the scrubber and pruner do not depend on @rrweb/types resolution. Values
// mirror rrweb-snapshot's NodeType enum.
export const SN_DOCUMENT = 0 as const;
export const SN_DOCTYPE = 1 as const;
export const SN_ELEMENT = 2 as const;
export const SN_TEXT = 3 as const;
export const SN_CDATA = 4 as const;
export const SN_COMMENT = 5 as const;

export type SnAttributeValue = string | number | boolean | null;

export interface SnElement {
  type: typeof SN_ELEMENT;
  id: number;
  tagName: string;
  attributes: Record<string, SnAttributeValue>;
  childNodes: SnNode[];
  isSVG?: true;
  isShadowHost?: boolean;
  isShadow?: boolean;
  isCustom?: true;
  rootId?: number;
}

export interface SnText {
  type: typeof SN_TEXT;
  id: number;
  textContent: string;
  isStyle?: true;
  rootId?: number;
}

export interface SnDocument {
  type: typeof SN_DOCUMENT;
  id: number;
  childNodes: SnNode[];
  compatMode?: string;
  rootId?: number;
}

export interface SnOther {
  type: typeof SN_DOCTYPE | typeof SN_CDATA | typeof SN_COMMENT;
  id: number;
  textContent?: string;
  name?: string;
  publicId?: string;
  systemId?: string;
  rootId?: number;
}

export type SnNode = SnDocument | SnElement | SnText | SnOther;
export type SnParent = SnDocument | SnElement;
