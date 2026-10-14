<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @everframe/protocol

> Wire-protocol package — touch with care. Both SDK and server depend on this contract.

**License:** MIT

## What this is

The versioned wire contract between Everframe SDKs (web, RN, RN-TV) and the Everframe ingest service.
Defines the `ReportEnvelope` Zod schema (runtime validation + TS types) and a generated language-neutral
JSON Schema (Draft 2020-12) consumable by Kotlin/Swift codegen for future SDKs.

## Versioning policy

**Additive-only forever within a major.** v1.x stays compatible across all minors:

- Server tolerates unknown SDK fields (every nested object is `passthrough()`)
- SDK ignores unknown server response fields
- New fields are always optional
- Renaming or removing a field requires a major bump (v2)

**Mismatch behavior:**

- Major mismatch → server returns `426 Upgrade Required` with `{ supported: ['1.x'] }`
- Minor mismatches → silent (handled by passthrough)

## JSON Schema

`schemas-json/envelope.v1.schema.json` is generated from the Zod schema via `z.toJSONSchema()` (Zod 4 native).
It is committed alongside source so:

1. Kotlin/Swift SDKs can codegen against a stable file path
2. CI drift-detection (`pnpm schema:check`) fails if regeneration produces a different output

Regeneration is deterministic: two consecutive `pnpm schema:generate` runs produce byte-identical output.

## Public API

```ts
import {
  ReportEnvelope,
  PROTOCOL_VERSION,
  SDKPlatform,
  FormFactor,
  UITree,
  UINode,
  FocusedNode,
  AttachmentRef,
  AttachmentKind,
} from '@everframe/protocol';
```

`payload.uiTree`, `payload.reactTree`, and `payload.reportTarget` have been
removed from the envelope schema and generated Swift/Kotlin models. The
TypeScript parser still preserves unknown extensions; native decoders ignore
these historical fields. No current producer emits them. `captures.uiTree`
remains a required capability flag, emitted as `false`.

Standalone `UITree` / `UINode` schemas remain for privacy handling of historical
raw data and fixture tools. Web rrweb and native `everframe-vtree-v1`
replay format are unaffected.

`PROTOCOL_VERSION` is the literal `'1.0'`.

`SDKPlatform` enum includes all v1 + v1.1 platform literals:
`'web' | 'ios' | 'android' | 'tvos' | 'tizen' | 'webos' | 'androidtv'`.

Tizen and webOS are reserved for v1.1 SDK delivery — the protocol enum already includes them so v1.1 expansion is a code change, not a wire-format change (PLAT-04).

## Generation

```bash
pnpm --filter @everframe/protocol build   # build dist/
pnpm schema:generate                     # write schemas-json/envelope.v1.schema.json
pnpm schema:check                        # drift gate (fails if generated output differs)
```

## Interaction targets

SDK-produced `tap` breadcrumbs may include `data.target`, described by
`InteractionTargetSchema` and `schemas-json/interaction-target.v1.schema.json`.
The optional descriptor carries `testId`, semantic `role`, `name` plus `nameFrom`,
`container` (stable ID/name/role and logical zero-based index/count), and `screen`.
Names can originate from `annotation`, `accessibility`, `text`, `testId`, or
`className`; the latter two are weak fallbacks. Unknown fields are omitted.

Masked targets contain only `{ role?, masked: true }`. SDK producers also remove
legacy identifying breadcrumb fields and mask the message. Annotations cannot
turn masking off. Position counts describe the logical collection, not its
currently mounted children. If both positions are supplied, producers enforce
`index < count`; JSON Schema validates structural bounds, while this correlated
constraint belongs to the producer normalizer.

`InteractionTargetAnnotation` permits optional `testId`, `role`, `name`, and
`container`. `normalizeInteractionTargetAnnotation` drops invalid fields and
bounds strings to 256 UTF-16 units (64 for roles), preserving surrogate pairs.
Use normal accessibility labels/roles and test IDs before adding overrides.

These schemas describe producer output without restricting historical/custom
`Breadcrumb.data`. No target or annotation is required to submit a report.
The protocol package minor version increases; envelope `protocolVersion` stays
`1.0` so older readers continue accepting additive breadcrumb data.

Regenerate the standalone schema after building the protocol:

```sh
pnpm --filter @everframe/protocol build
pnpm --filter @everframe/protocol schema:interaction-target
```
