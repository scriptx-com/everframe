// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Native session-replay blob contract. The old discriminator remains readable
// because existing reports persist it; new producers use everframe-vtree-v1.
//
// This is the cross-implementation contract for native session replay: the
// blob-bytes shape that the iOS producer (Phase 22), the Android producer
// (Phase 23), and the dashboard player (Phase 25) all validate against. It is
// a STANDALONE namespaced module (mirroring src/relay/) and is NEVER nested in
// ReportEnvelope — the envelope already carries the `format:
// version discriminator via ReplayFormat in attachments.ts.
//
// The format is a labeled-wireframe model: structural fidelity (layout + real
// text + diffs over time), deliberately NOT pixels. This is what lets native
// replay be silent, permission-free, scoped to the app, and cheap.
//
// JSON Schema is emitted from this Zod source via
// `scripts/generate-json-schema.mjs` (Zod 4 native `z.toJSONSchema`); custom
// Swift/Kotlin emitters (Plan 02) consume that JSON Schema. The recursive ref
// is anonymized by Zod (e.g. `__schema0`) — the custom emitters resolve it
// back to a single `VNode` name.

import { z } from 'zod';

// Platform-neutral semantic role. NO platform identity (no UIView /
// android.view.View) and no platform-specific layout props. An `image` role
// node renders real bytes when it carries an `imageRef` that resolves against
// the timeline's `assets` table, and falls back to a solid placeholder box
// (uses bg/frame) otherwise. A distinct opaque/`media` placeholder role is
// deferred to v2.
export const VRole = z.enum(['view','text','image','input','button','scroll','list-item']);

// Recursive type matches z.optional() emit shape under
// exactOptionalPropertyTypes: an optional property may be omitted OR explicitly
// set to undefined, hence `?: T | undefined`.
//
// FORMAT INVARIANTS (load-bearing — the player and hit-test depend on them):
//   (a) `id` is a stable, producer-assigned handle, UNIQUE within a timeline,
//       that PERSISTS across frames. Diffing is id-keyed, NEVER index-keyed.
//   (b) `children` array order == paint order; the LATER child paints ON TOP
//       (matches the find-path-at.json "children walked in REVERSE" convention,
//       so player and hit-test agree).
//   (c) `frame` is logical points (DIPs), top-left origin.
//   (d) an `image` role node carries real bytes INDIRECTLY: `imageRef` is a key
//       into the timeline's `assets` table, never a URL and never inline bytes
//       on the node. A ref that does not resolve — a pruned table, a truncated
//       blob, an older player — degrades to the solid placeholder box
//       (uses bg/frame), never to a broken image.
//       History: v1 originally shipped NO image bytes at all and deferred real
//       thumbnails to v2. That decision landed here instead, additively: URLs
//       were rejected because they are unreachable for Compose/SwiftUI
//       AsyncImage, expire when signed, and would make the viewer's browser
//       fetch from the customer's CDN.
//   (e) `masked` is an ADDITIVE optional field PRESENT in this version. It is
//       the PII redaction flag: a `masked: true` node MUST carry NO `text` and
//       NO `imageRef` (the screenshot-blackout parity guarantee). This
//       per-node invariant (`masked ⇒ no text/image`) is enforced by the Zod
//       `.refine` below (TS `.parse()`), the golden fixture, and a loud
//       doc-comment in the generated Swift/Kotlin types — it is NOT enforced by
//       JSON Schema / ajv / codegen, because `z.toJSONSchema` SILENTLY DROPS
//       `.refine` (22-RESEARCH §Pitfall 1). SUBTREE masking (hiding a whole
//       branch) is the PRODUCER's responsibility (Phase 22/23), NOT a format
//       recursive rule — the format only constrains the single masked node.
//       Both clauses are live: the image clause was dormant only while v1
//       carried no image bytes, and stage 4a ended that. The PLAYER checks
//       `masked` first and never reads `imageRef` regardless, so a blob that
//       illegally carries one still renders nothing — defence in depth, since
//       a producer bug here is a PII leak.
export interface VNode {
  id: string;
  role: z.infer<typeof VRole>;
  frame: { x: number; y: number; w: number; h: number };
  bg?: string | undefined;
  text?: string | undefined;
  masked?: boolean | undefined;
  alpha?: number | undefined;
  cornerRadius?: number | undefined;
  fontSize?: number | undefined;
  textColor?: string | undefined;
  textAlign?: 'left' | 'center' | 'right' | undefined;
  fontWeight?: number | undefined;
  borderWidth?: number | undefined;
  borderColor?: string | undefined;
  /** Key into VTreeTimeline.assets. See invariant (d). */
  imageRef?: string | undefined;
  children: VNode[];
}

export const VNode: z.ZodType<VNode> = z.lazy(() =>
  z
    .object({
      id: z.string(),
      role: VRole,
      frame: z.object({
        x: z.number(),
        y: z.number(),
        w: z.number(),
        h: z.number(),
      }),
      bg: z.string().optional(),
      text: z.string().optional(),
      masked: z.boolean().optional(),
      alpha: z.number().optional(),
      cornerRadius: z.number().optional(),
      fontSize: z.number().optional(),
      textColor: z.string().optional(),
      // Stage 2a — ADDITIVE optional, same convention as `masked` and
      // `originEpochMs`: an old player strips what it does not know and keeps
      // playing. `justify` is deliberately absent from the enum (a justified
      // paragraph maps to `left` at the producer); a fourth value can be added
      // additively if a real producer needs it.
      textAlign: z.enum(['left', 'center', 'right']).optional(),
      // CSS numeric weight scale. Bounded 1..1000, NOT 100..900: Android's
      // Typeface.getWeight() returns up to 1000 and CSS accepts 1..1000, so a
      // 900 cap would falsely reject real Android values.
      fontWeight: z.number().int().min(1).max(1000).optional(),
      borderWidth: z.number().optional(),
      borderColor: z.string().optional(),
      // Stage 4a — ADDITIVE optional. A KEY into the timeline's `assets`
      // table, never a URL and never inline bytes: keeping the bytes in one
      // table is what makes dedupe inherent and what lets the table be built
      // at freeze time from only the hashes that survive the frozen window.
      imageRef: z.string().optional(),
      children: z.array(VNode),
    })
    // Per-node masked invariant: a masked node carries NO text/image payload.
    // BOTH clauses are live as of stage 4a — the image half was dormant only
    // while v1 shipped no image bytes. DROPPED by z.toJSONSchema (22-RESEARCH
    // §Pitfall 1) — this is the ONLY place it is type-enforced.
    .refine(
      (n) => !(n.masked === true && (n.text !== undefined || n.imageRef !== undefined)),
      {
        message:
          'masked node must carry no text/image payload (text or imageRef present)',
      },
    )
    .meta({ $id: 'VNode' })
);

// VOp — the per-frame diff. Discriminated union on `op`, mirroring the
// relay/messages.ts discriminated-union + `.meta({ $id })`-per-branch convention.

// `set` = partial-attr patch: the node `id` + ONLY the changed fields (all
// attrs optional). The player merges against prior state.
//
// UNSET SEMANTICS — a KNOWN, LIVE GAP: an omitted field means "no change", so
// clearing a value (set-to-absent) is not expressible. The producers encode a
// present->absent transition as a null field, the encoders omit nulls
// (`explicitNulls = false` on Kotlin's, and the TS/Swift equivalents), and the
// player applies only keys PRESENT in the object — so the node keeps the stale
// value for the rest of the retained diff chain.
//
// This comment previously read "acceptable because v1 has no producer". That
// is no longer true: iOS and Android both ship producers, so the gap is live
// for every one of these attrs, most visibly `bg` (a view that loses its
// background keeps painting the old one). `imageRef` below inherits it — an
// image node that stops showing an image keeps showing the last one.
//
// A clear-list or null-sentinel is the additive fix and is tracked as its own
// stage; it is deliberately NOT bolted onto stage 4a, which is otherwise a
// purely additive contract change.
export const VOpSet = z
  .object({
    op: z.literal('set'),
    id: z.string(),
    frame: z
      .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
      .optional(),
    bg: z.string().optional(),
    text: z.string().optional(),
    alpha: z.number().optional(),
    cornerRadius: z.number().optional(),
    fontSize: z.number().optional(),
    textColor: z.string().optional(),
    borderWidth: z.number().optional(),
    borderColor: z.string().optional(),
    // Stage 2a — present on BOTH VNode and VOpSet. A field on VNode alone
    // ships in the frame-0 snapshot and can never be updated by a diff.
    textAlign: z.enum(['left', 'center', 'right']).optional(),
    fontWeight: z.number().int().min(1).max(1000).optional(),
    // Stage 4a — present on BOTH VNode and VOpSet for the same reason
    // textAlign/fontWeight are: a field on VNode alone ships in the frame-0
    // snapshot and could never be updated by a diff.
    imageRef: z.string().optional(),
  })
  .meta({ $id: 'VOpSet' });

// `add` = embedded subtree: the full VNode (including its children) is inserted
// at `index` into the ordered `children` array of the `parent` node.
export const VOpAdd = z
  .object({
    op: z.literal('add'),
    parent: z.string(),
    index: z.number().int(),
    node: VNode,
  })
  .meta({ $id: 'VOpAdd' });

// `remove` = remove the node with this `id` (and, implicitly, its subtree).
export const VOpRemove = z
  .object({
    op: z.literal('remove'),
    id: z.string(),
  })
  .meta({ $id: 'VOpRemove' });

export const VOp = z.discriminatedUnion('op', [VOpSet, VOpAdd, VOpRemove]).meta({ $id: 'VOp' });

// A single frame: a per-frame millisecond `timestamp` (cadence-agnostic — the
// format imposes no fixed rate; producers choose cadence) plus the list of
// VOp diffs that transform the prior frame's tree into this frame's tree.
export const VFrame = z
  .object({
    timestamp: z.number(),
    ops: z.array(VOp),
  })
  .meta({ $id: 'VFrame' });

// VAsset — one encoded image in the timeline's asset table.
//
// The bytes travel INLINE, base64, in this one blob rather than as a second
// multipart part or a URL: one presigned blob, one fetch, and the assets are
// lifecycle-bound to the replay they belong to (they cannot outlive it or be
// fetched independently).
//
// `w`/`h` are the ENCODED pixel dimensions — the size of the bytes in `b64`,
// after any producer-side downscaling. They are deliberately NOT the node's
// layout size: the node's `frame` already carries that, and conflating the two
// would make a downscaled asset render at the wrong size.
export const VAsset = z
  .object({
    mime: z.enum(['image/webp', 'image/jpeg', 'image/png']),
    w: z.number(),
    h: z.number(),
    b64: z.string(),
  })
  .meta({ $id: 'VAsset' });

// VTreeTimeline — the top-level blob.
//
// frames[0] is the FULL self-contained snapshot frame: to keep it replayable on
// its own, it is encoded as a SINGLE VOpAdd whose `node` is the full root
// subtree, inserted with `parent: ''` (the documented root sentinel — the empty
// string is reserved to mean "the timeline root") at `index: 0`.
// frame N>0 carries VOp diffs applied (id-keyed) against the tree produced by
// frame N-1.
//
// `viewport` = logical points {width, height} (DIPs) + device `scale` factor
// (e.g. @2x/@3x). ALL frames are expressed in this one pinned logical-point
// coordinate space; the player maps points → CSS px.
export const VTreeTimeline = z
  .object({
    version: z.enum(['everframe-vtree-v1', 'traceitx-vtree-v1']),
    viewport: z.object({
      width: z.number(),
      height: z.number(),
      scale: z.number(),
    }),
    frames: z.array(VFrame),
    /**
     * Wall-clock epoch ms of the producer's sessionEpoch (the monotonic zero
     * frames are stamped against): a frame's absolute wall-clock time is
     * `originEpochMs + frame.timestamp`. OPTIONAL + additive — pre-anchor
     * blobs lack it and viewers must degrade (no crumb↔frame alignment).
     */
    originEpochMs: z.number().optional(),
    /**
     * Image bytes referenced by nodes' `imageRef`, keyed by CONTENT HASH: the
     * first 16 hex characters of the sha256 of the encoded bytes. Producers
     * and player agree on that key format, and because it is content-addressed
     * dedupe is inherent — two nodes showing the same image cost ONE entry, and
     * the same image recurring across frames costs nothing further.
     *
     * Built at FREEZE TIME from the hashes still referenced by the frames that
     * survive in the frozen window. This matters: the replay buffer is a
     * rolling window that prunes frames, so a table assembled as images were
     * captured would ship bytes for screens the user left minutes ago.
     *
     * OPTIONAL + additive — a blob with no `assets` key is normal (every blob
     * written before stage 4a, and every capture with images disabled), and
     * every unresolved `imageRef` degrades to the placeholder box.
     */
    assets: z.record(z.string(), VAsset).optional(),
  })
  .meta({ $id: 'VTreeTimeline' });

export type VTreeTimeline = z.infer<typeof VTreeTimeline>;
