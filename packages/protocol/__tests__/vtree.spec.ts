// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// VTREE-01 golden-fixture parity gate (TS half).
//
// The single `vtree.v1-fixture.json` is the cross-SDK source of truth: iOS
// (Phase 22), Android (Phase 23), and the dashboard player (Phase 25) all
// validate against this exact artifact. This spec closes the TS half and the
// highest-liability gates:
//   1. byte-equal round-trip (parse → re-encode → canonical-equal)
//   2. id-keyed apply-frames diff semantics vs. a render oracle
//   3. unknown-role rejection (negative parse)
//   4. ajv 2020 independent schema validation of the fixture
//   5. generated-native-shape guard (one VNode + VOp enum/sealed class) so the
//      contract can't silently rot (Pitfall-1 guard).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import fixture from './fixtures/vtree.v1-fixture.json' with { type: 'json' };
import { vtree } from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Canonicalize JSON value: deep sort object keys so re-serialization is
 * deterministic regardless of insertion order. Arrays preserve order
 * (semantically meaningful — children[] order == paint order). Reused verbatim
 * from relay-cross-sdk.spec.ts.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = canonicalize(obj[k]);
    }
    return sorted;
  }
  return value;
}

// ---------------------------------------------------------------------------
// applyFrames — the id-keyed diff oracle.
//
// Build a mutable tree from frame 0 (the snapshot encoded as a single VOpAdd at
// the root sentinel parent ''), then apply each subsequent frame's ops in
// order: set = shallow-merge changed attrs by id; add = insert the embedded
// subtree into parent.children at index; remove = delete the node (and subtree)
// by id. Returns the rendered root subtree as a plain JSON object.
// ---------------------------------------------------------------------------
// Explicit op union (NOT inferred from the JSON literal): the fixture's literal
// type narrows each op member to only its own keys, so a derived
// `Frame['ops'][number]` cannot be discriminated. Model the runtime VOp shape
// directly so the oracle type-checks regardless of which nodes the fixture
// carries (e.g. the masked `secret` node).
type Op =
  | { op: 'add'; parent: string; index: number; node: unknown }
  | { op: 'set'; id: string; [k: string]: unknown }
  | { op: 'remove'; id: string };
// A render node is a plain VNode-shaped object with a mutable children array.
type RenderNode = Record<string, unknown> & { id: string; children: RenderNode[] };

function applyFrames(timeline: typeof fixture.timeline): RenderNode {
  let root: RenderNode | null = null;

  // index of id -> node, rebuilt lazily so add/remove stay correct.
  const findById = (node: RenderNode, id: string): RenderNode | null => {
    if (node.id === id) return node;
    for (const child of node.children) {
      const hit = findById(child, id);
      if (hit) return hit;
    }
    return null;
  };
  const removeById = (node: RenderNode, id: string): boolean => {
    const idx = node.children.findIndex((c) => c.id === id);
    if (idx !== -1) {
      node.children.splice(idx, 1);
      return true;
    }
    return node.children.some((c) => removeById(c, id));
  };
  const clone = (n: unknown): RenderNode => JSON.parse(JSON.stringify(n)) as RenderNode;

  for (const frame of timeline.frames) {
    for (const op of frame.ops as unknown as Op[]) {
      if (op.op === 'add') {
        const node = clone(op.node);
        if (op.parent === '') {
          // root sentinel — frame-0 snapshot.
          root = node;
        } else {
          if (!root) throw new Error('add before snapshot');
          const parent = findById(root, op.parent);
          if (!parent) throw new Error(`add: parent ${op.parent} not found`);
          parent.children.splice(op.index, 0, node);
        }
      } else if (op.op === 'set') {
        if (!root) throw new Error('set before snapshot');
        const target = findById(root, op.id);
        if (!target) throw new Error(`set: id ${op.id} not found`);
        // partial-attr patch: only the present (non-op, non-id) fields change.
        for (const [k, v] of Object.entries(op)) {
          if (k === 'op' || k === 'id') continue;
          target[k] = v as unknown;
        }
      } else if (op.op === 'remove') {
        if (!root) throw new Error('remove before snapshot');
        removeById(root, op.id);
      }
    }
  }

  if (!root) throw new Error('timeline produced no root');
  return root;
}

describe('VTREE-01 golden fixture — round-trip', () => {
  it('parse → re-encode → canonical-equal (byte-equal round-trip)', () => {
    const parsed = vtree.VTreeTimeline.parse(fixture.timeline);
    const reencoded = JSON.parse(JSON.stringify(parsed));
    expect(canonicalize(reencoded)).toEqual(canonicalize({
      ...fixture.timeline,
      version: 'everframe-vtree-v1',
    }));
  });

  it('fixture has a frame-0 snapshot + set/add/remove diff frames', () => {
    const ops = fixture.timeline.frames
      .flatMap((f) => f.ops as unknown as Op[])
      .map((o) => o.op);
    expect(ops).toContain('add');
    expect(ops).toContain('set');
    expect(ops).toContain('remove');
  });
});

describe('VTREE-01 golden fixture — apply-frames diff semantics', () => {
  const rendered = applyFrames(fixture.timeline);

  it('reproduces the expected render state after all frames (render oracle)', () => {
    expect(canonicalize(rendered)).toEqual(
      canonicalize(fixture.expectedRenderAfterAllFrames)
    );
  });

  it('set patches title text by id (persists across frames)', () => {
    const card = rendered.children.find((c) => c.id === 'card')!;
    const title = card.children.find((c) => c.id === 'title')!;
    expect(title.text).toBe('Updated');
  });

  it('add inserts the badge subtree into card', () => {
    const card = rendered.children.find((c) => c.id === 'card')!;
    expect(card.children.some((c) => c.id === 'badge')).toBe(true);
  });

  it('remove deletes the input node by id', () => {
    const card = rendered.children.find((c) => c.id === 'card')!;
    expect(card.children.some((c) => c.id === 'input')).toBe(false);
  });

  it('children[] order == paint order: overlayBadge paints on top of card', () => {
    const ids = rendered.children.map((c) => c.id);
    expect(ids).toEqual(['card', 'overlayBadge']);
    // later sibling (overlayBadge) is last in the array → on top.
    expect(ids.indexOf('overlayBadge')).toBeGreaterThan(ids.indexOf('card'));
  });
});

describe('VTREE-01 golden fixture — negative parse', () => {
  it('rejects a timeline whose snapshot root has an unknown role', () => {
    expect(() => vtree.VTreeTimeline.parse(fixture.invalidUnknownRole)).toThrow();
  });
});

describe('VTREE-02 masked invariant — Zod .refine', () => {
  // The masked invariant (`masked: true ⇒ no text/image payload`) is enforced
  // ONLY at the Zod `.parse()` layer + the golden fixture + the generated
  // Swift/Kotlin doc-comment. It is NOT in JSON Schema (z.toJSONSchema DROPS
  // `.refine` — 22-RESEARCH Pitfall 1), so ajv intentionally does NOT catch it.
  const validMasked = {
    id: 'x',
    role: 'view' as const,
    frame: { x: 0, y: 0, w: 1, h: 1 },
    masked: true,
    children: [],
  };

  it('rejects a masked VNode that carries text (refine violation)', () => {
    expect(() =>
      vtree.VNode.parse({ ...validMasked, text: 'secret' })
    ).toThrow();
  });

  it('accepts a masked VNode with no text and re-encodes canonical-equal', () => {
    const parsed = vtree.VNode.parse(validMasked);
    const reencoded = JSON.parse(JSON.stringify(parsed));
    expect(canonicalize(reencoded)).toEqual(canonicalize(validMasked));
  });

  it('rejects a timeline whose snapshot contains a masked+text node', () => {
    expect(() =>
      vtree.VTreeTimeline.parse(fixture.invalidMaskedWithText)
    ).toThrow();
  });

  it('apply-frames carries the masked node through into the render oracle', () => {
    const rendered = applyFrames(fixture.timeline);
    const card = rendered.children.find((c) => c.id === 'card')!;
    const secret = card.children.find((c) => c.id === 'secret');
    expect(secret).toBeDefined();
    expect((secret as Record<string, unknown>).masked).toBe(true);
    expect((secret as Record<string, unknown>).text).toBeUndefined();
  });
});

describe('VTREE-01 emitted schema — ajv 2020 independent validation', () => {
  const schemaPath = path.resolve(
    __dirname,
    '../schemas-json/vtree.v1.schema.json'
  );
  const jsonSchema = JSON.parse(readFileSync(schemaPath, 'utf8'));

  // ajv & ajv-formats publish dual ESM/CJS — under verbatimModuleSyntax we get
  // the namespace; the constructor / plugin fn lives on `.default`.
  const AjvCtor = (Ajv as unknown as { default: typeof Ajv }).default ?? Ajv;
  const addFormatsFn =
    (addFormats as unknown as { default: typeof addFormats }).default ??
    addFormats;

  it('is Draft 2020-12', () => {
    expect(jsonSchema.$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema'
    );
  });

  it('validates the golden fixture timeline via ajv (independent validator)', () => {
    const ajv = new AjvCtor({ strict: false, allErrors: true });
    addFormatsFn(ajv);
    const validate = ajv.compile(jsonSchema);
    const ok = validate(fixture.timeline);
    if (!ok) console.error(validate.errors);
    expect(ok).toBe(true);
  });

  it('validates a node carrying textAlign + fontWeight (stage 2a)', () => {
    const ajv = new AjvCtor({ strict: false, allErrors: true });
    addFormatsFn(ajv);
    const validate = ajv.compile(jsonSchema);
    const ok = validate({
      version: 'traceitx-vtree-v1',
      viewport: { width: 100, height: 200, scale: 2 },
      frames: [
        {
          timestamp: 0,
          ops: [
            {
              op: 'add',
              parent: '',
              index: 0,
              node: {
                id: 'n1',
                role: 'text',
                frame: { x: 0, y: 0, w: 10, h: 10 },
                children: [],
                text: 'hi',
                textAlign: 'center',
                fontWeight: 600,
              },
            },
          ],
        },
        {
          timestamp: 100,
          ops: [{ op: 'set', id: 'n1', textAlign: 'left', fontWeight: 400 }],
        },
      ],
    });
    if (!ok) console.error(validate.errors);
    expect(ok).toBe(true);
  });

  it('validates a timeline carrying an assets table and a node with imageRef (stage 4a)', () => {
    // This is the case that proves the GENERATED SCHEMA knows the new shapes,
    // not merely the Zod source: the emitted schema is `additionalProperties:
    // false`, so before the contract change ajv rejects both `assets` and
    // `imageRef` as unknown properties.
    const ajv = new AjvCtor({ strict: false, allErrors: true });
    addFormatsFn(ajv);
    const validate = ajv.compile(jsonSchema);
    const ok = validate({
      version: 'traceitx-vtree-v1',
      viewport: { width: 100, height: 200, scale: 2 },
      assets: {
        a1b2c3d4e5f60718: {
          mime: 'image/webp',
          w: 64,
          h: 64,
          b64: 'AAAA',
        },
      },
      frames: [
        {
          timestamp: 0,
          ops: [
            {
              op: 'add',
              parent: '',
              index: 0,
              node: {
                id: 'n1',
                role: 'image',
                frame: { x: 0, y: 0, w: 10, h: 10 },
                children: [],
                imageRef: 'a1b2c3d4e5f60718',
              },
            },
          ],
        },
        {
          timestamp: 100,
          ops: [{ op: 'set', id: 'n1', imageRef: 'a1b2c3d4e5f60718' }],
        },
      ],
    });
    if (!ok) console.error(validate.errors);
    expect(ok).toBe(true);
  });
});

describe('VTREE-03 originEpochMs — optional wall-clock anchor', () => {
  it('parses a timeline WITH originEpochMs', () => {
    const withOrigin = { ...fixture.timeline, originEpochMs: 1751884800000 };
    const parsed = vtree.VTreeTimeline.parse(withOrigin);
    expect(parsed.originEpochMs).toBe(1751884800000);
  });

  it('parses a timeline WITHOUT originEpochMs (legacy blobs degrade gracefully)', () => {
    const parsed = vtree.VTreeTimeline.parse(fixture.timeline);
    expect(parsed.originEpochMs).toBeUndefined();
  });

  it('emitted JSON Schema carries originEpochMs as an additive optional property', () => {
    const schemaPath = path.resolve(
      __dirname,
      '../schemas-json/vtree.v1.schema.json'
    );
    const jsonSchema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(jsonSchema.properties).toHaveProperty('originEpochMs');
    expect(jsonSchema.required ?? []).not.toContain('originEpochMs');
  });
});

describe('VTREE-01 generated native shape guard (Pitfall-1)', () => {
  const swiftPath = path.resolve(
    __dirname,
    '../../sdk-ios/Sources/TraceItXProtocol/VTree.swift'
  );
  const kotlinPath = path.resolve(
    __dirname,
    '../../sdk-android/android/traceitx-protocol/src/main/kotlin/com/traceitx/protocol/generated/VTree.kt'
  );

  it('Swift emits exactly one Everframe node struct + operation enum', () => {
    const swift = readFileSync(swiftPath, 'utf8');
    expect((swift.match(/struct EverframeVNode/g) || []).length).toBe(1);
    expect(/enum EverframeVOp/.test(swift)).toBe(true);
  });

  it('Kotlin emits exactly one `data class VNode` + a `sealed class VOp`', () => {
    const kt = readFileSync(kotlinPath, 'utf8');
    expect((kt.match(/data class VNode/g) || []).length).toBe(1);
    expect(/sealed class VOp/.test(kt)).toBe(true);
  });

  // Stage 4a — `assets` is a MAP keyed by content hash, which the JSON Schema
  // expresses as an object with no `properties` and an object-valued
  // `additionalProperties`. Both emitters previously understood only
  // fixed-property objects and turned that into an EMPTY struct/data class
  // with no storage at all — the native SDKs could not carry assets, and it
  // compiled clean, so nothing downstream would have caught it until the 4c/4d
  // producers had nowhere to put bytes. These pin the map shape.

  it('Swift emits EverframeVAsset with its four fields and types `assets` as a dictionary', () => {
    const swift = readFileSync(swiftPath, 'utf8');
    expect((swift.match(/struct EverframeVAsset\b/g) || []).length).toBe(1);
    for (const field of ['mime', 'w', 'h', 'b64']) {
      expect(swift).toMatch(new RegExp(`public let ${field}:`));
    }
    expect(swift).toMatch(/assets: \[String: EverframeVAsset\]\?/);
    expect(swift).not.toMatch(/EverframeVTreeTimelineAssets/);
  });

  it('Kotlin emits VAsset with its four fields and types `assets` as a Map', () => {
    const kt = readFileSync(kotlinPath, 'utf8');
    expect((kt.match(/data class VAsset\b/g) || []).length).toBe(1);
    for (const field of ['mime', 'w', 'h', 'b64']) {
      expect(kt).toMatch(new RegExp(`val ${field}:`));
    }
    expect(kt).toMatch(/assets: Map<String, VAsset>\? = null/);
    expect(kt).not.toMatch(/VTreeTimelineAssets/);
  });

  it('both generated types carry imageRef on the node and the set op', () => {
    const swift = readFileSync(swiftPath, 'utf8');
    const kt = readFileSync(kotlinPath, 'utf8');
    expect((swift.match(/public let imageRef: String\?/g) || []).length).toBe(2);
    expect((kt.match(/val imageRef: String\? = null/g) || []).length).toBe(2);
  });
});

describe('vtree v1 — textAlign + fontWeight (stage 2a, additive)', () => {
  const nodeWith = (extra: Record<string, unknown>) => ({
    id: 'n1',
    role: 'text' as const,
    frame: { x: 0, y: 0, w: 10, h: 10 },
    children: [],
    ...extra,
  });

  it('accepts textAlign and fontWeight on a VNode', () => {
    const parsed = vtree.VNode.parse(
      nodeWith({ text: 'hi', textAlign: 'center', fontWeight: 700 }),
    );
    expect(parsed.textAlign).toBe('center');
    expect(parsed.fontWeight).toBe(700);
  });

  it('both fields are optional (a node without them still parses)', () => {
    const parsed = vtree.VNode.parse(nodeWith({}));
    expect(parsed.textAlign).toBeUndefined();
    expect(parsed.fontWeight).toBeUndefined();
  });

  it('rejects an unknown textAlign value', () => {
    expect(() => vtree.VNode.parse(nodeWith({ textAlign: 'justify' }))).toThrow();
  });

  it('accepts the full CSS numeric weight range and rejects outside it', () => {
    expect(vtree.VNode.parse(nodeWith({ fontWeight: 1 })).fontWeight).toBe(1);
    // Android's Typeface.getWeight() returns up to 1000 — 900 must NOT be the cap.
    expect(vtree.VNode.parse(nodeWith({ fontWeight: 1000 })).fontWeight).toBe(1000);
    expect(() => vtree.VNode.parse(nodeWith({ fontWeight: 0 }))).toThrow();
    expect(() => vtree.VNode.parse(nodeWith({ fontWeight: 1001 }))).toThrow();
    expect(() => vtree.VNode.parse(nodeWith({ fontWeight: 400.5 }))).toThrow();
  });

  it('carries both fields on a set op so a diff can update them', () => {
    const op = vtree.VOpSet.parse({
      op: 'set',
      id: 'n1',
      textAlign: 'right',
      fontWeight: 300,
    });
    expect(op.textAlign).toBe('right');
    expect(op.fontWeight).toBe(300);
  });

  it('a timeline carrying both fields round-trips canonical-equal', () => {
    const timeline = {
      version: 'everframe-vtree-v1' as const,
      viewport: { width: 100, height: 200, scale: 2 },
      frames: [
        {
          timestamp: 0,
          ops: [
            {
              op: 'add' as const,
              parent: '',
              index: 0,
              node: nodeWith({ text: 'hi', textAlign: 'center', fontWeight: 600 }),
            },
          ],
        },
        {
          timestamp: 100,
          ops: [{ op: 'set' as const, id: 'n1', textAlign: 'left', fontWeight: 400 }],
        },
      ],
    };
    const parsed = vtree.VTreeTimeline.parse(timeline);
    expect(canonicalize(JSON.parse(JSON.stringify(parsed)))).toEqual(
      canonicalize(timeline),
    );
  });

});

describe('VTREE-04 image asset table (stage 4a)', () => {
  // The map key is the first 16 hex of the sha256 of the ENCODED image bytes,
  // so dedupe is inherent: two nodes showing the same image reference one
  // entry. `w`/`h` are the ENCODED pixel dimensions (post-downscale), which is
  // deliberately NOT the node's layout size — `frame` already carries that.
  const assetKey = 'a1b2c3d4e5f60718';
  const asset = { mime: 'image/webp' as const, w: 64, h: 48, b64: 'AAAA' };

  const imageNode = (extra: Record<string, unknown> = {}) => ({
    id: 'img1',
    role: 'image' as const,
    frame: { x: 0, y: 0, w: 10, h: 10 },
    children: [],
    ...extra,
  });

  const timelineWith = (extra: Record<string, unknown>) => ({
    version: 'everframe-vtree-v1' as const,
    viewport: { width: 100, height: 200, scale: 2 },
    frames: [
      {
        timestamp: 0,
        ops: [
          { op: 'add' as const, parent: '', index: 0, node: imageNode({ imageRef: assetKey }) },
        ],
      },
    ],
    ...extra,
  });

  it('parses a VNode carrying imageRef and round-trips it', () => {
    const node = imageNode({ imageRef: assetKey });
    const parsed = vtree.VNode.parse(node);
    expect((parsed as unknown as Record<string, unknown>).imageRef).toBe(assetKey);
    expect(canonicalize(JSON.parse(JSON.stringify(parsed)))).toEqual(canonicalize(node));
  });

  it('treats imageRef as optional — a node without it still parses', () => {
    const parsed = vtree.VNode.parse(imageNode());
    expect((parsed as unknown as Record<string, unknown>).imageRef).toBeUndefined();
  });

  it('carries imageRef on VOpSet, so a diff can change which image a node shows', () => {
    // On BOTH VNode and VOpSet deliberately: a field on VNode alone ships in
    // the frame-0 snapshot and could never be updated by a later frame.
    const op = { op: 'set' as const, id: 'img1', imageRef: assetKey };
    const parsed = vtree.VOpSet.parse(op);
    expect(parsed.imageRef).toBe(assetKey);
  });

  it('parses a timeline with an assets table and round-trips it canonical-equal', () => {
    const timeline = timelineWith({ assets: { [assetKey]: asset } });
    const parsed = vtree.VTreeTimeline.parse(timeline);
    expect(parsed.assets?.[assetKey]).toEqual(asset);
    expect(canonicalize(JSON.parse(JSON.stringify(parsed)))).toEqual(canonicalize(timeline));
  });

  it('parses a timeline with NO assets key (every blob written before this)', () => {
    const parsed = vtree.VTreeTimeline.parse(timelineWith({}));
    expect(parsed.assets).toBeUndefined();
  });

  it('REJECTS a masked node carrying imageRef (the extended refine)', () => {
    // The screenshot-blackout parity guarantee: a masked node carries no text
    // AND no image payload. Asserting the message, not merely that something
    // threw — a schema typo would also throw.
    const bad = imageNode({ masked: true, imageRef: assetKey });
    const result = vtree.VNode.safeParse(bad);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/masked node must carry no text\/image/);
  });

  it('still rejects a masked node carrying text (existing clause must not regress)', () => {
    const result = vtree.VNode.safeParse(imageNode({ masked: true, text: 'secret' }));
    expect(result.success).toBe(false);
  });

  it('accepts a masked node carrying NEITHER text nor imageRef', () => {
    const result = vtree.VNode.safeParse(imageNode({ masked: true }));
    expect(result.success).toBe(true);
  });

  it('rejects a VAsset with an unknown mime', () => {
    const result = vtree.VTreeTimeline.safeParse(
      timelineWith({ assets: { [assetKey]: { ...asset, mime: 'image/gif' } } }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts each supported mime', () => {
    for (const mime of ['image/webp', 'image/jpeg', 'image/png'] as const) {
      const result = vtree.VTreeTimeline.safeParse(
        timelineWith({ assets: { [assetKey]: { ...asset, mime } } }),
      );
      expect(result.success).toBe(true);
    }
  });
});

describe('VTree version compatibility', () => {
  it('decodes the legacy version and serializes only the Everframe version', () => {
    const legacy = {
      ...fixture.timeline,
      version: 'traceitx-vtree-v1' as const,
    };

    const parsed = vtree.VTreeTimeline.parse(legacy);

    expect(parsed.version).toBe('everframe-vtree-v1');
    expect(JSON.stringify(parsed)).toContain('"version":"everframe-vtree-v1"');
    expect(JSON.stringify(parsed)).not.toContain('traceitx-vtree-v1');
  });
});
