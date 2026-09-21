// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// REPLAY-04 — golden-file selective masking (HIGHEST-LIABILITY GATE).
//
// Policy (owner decision 2026-06-16 — SELECTIVE, watchable replay):
//   - Pattern PII (Luhn cards / JWTs / SSNs / emails) in any string leaf is MASKED.
//   - Input VALUES + leak-prone attributes (value/placeholder/title/alt/aria-label/
//     data-*) are STRIPPED by the allowlist.
//   - CSS url() query tokens in style/_cssText are STRIPPED.
//   - Ordinary UI text (#text nodes that are not pattern PII) stays VISIBLE so the
//     replay is watchable. Free-text non-pattern PII (names) is the customer's
//     responsibility via markSensitive (rrweb rr-block, omitted at capture) —
//     the standard session-replay posture.
import { describe, it, expect } from 'vitest';
import { gunzipSync, gzipSync } from 'node:zlib';
import { scrubReplayEvents } from '../../../src/capture/replay/scrub.js';
import { createReplayRecorder } from '../../../src/capture/replay/recorder.js';
import { REDACTION_DISABLED } from '../../../src/capture/replay/mask-mapping.js';

// jsdom Blob lacks .stream() → inject a node:zlib gzip that round-trips with gunzipSync.
const testGzip = async (input: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(gzipSync(Buffer.from(input)));

// Literals seeded into the fixture. Indices are referenced by seededFullSnapshot.
const SEEDED_PII = [
  '4111111111111111', // [0] Luhn-valid Visa test card (text node → pattern-masked)
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123signature', // [1] JWT (input value/attr → stripped)
  'victim@example.com', // [2] email (text node → pattern-masked; attrs → stripped)
  'hunter2secretpassword', // [3] password input value → stripped
  '123-45-6789', // [4] SSN hidden input value → stripped
  'John Smith', // [5] plain name in #text → VISIBLE (selective)
  '(415) 555-0132', // [6] phone in #text → VISIBLE (not a masked pattern)
  'hunter2-not-a-jwt-but-secret', // [7] custom free-text secret in #text → VISIBLE
  'csstok_SECRET_4827', // [8] CSS url() query token → stripped (CR-03)
];

// Pattern PII / input values / CSS tokens — MUST be masked or stripped.
const MUST_MASK = [
  SEEDED_PII[0]!, // card
  SEEDED_PII[1]!, // JWT
  SEEDED_PII[2]!, // email
  SEEDED_PII[3]!, // password value
  SEEDED_PII[4]!, // SSN value
  SEEDED_PII[8]!, // CSS token
];

// Non-pattern free text in #text nodes — VISIBLE by design (watchable replay).
const VISIBLE_TEXT = [
  SEEDED_PII[5]!, // name
  SEEDED_PII[6]!, // phone
  SEEDED_PII[7]!, // custom secret
];

const FULL = 2; // EventType.FullSnapshot

/**
 * Build an rrweb-style full-snapshot event with the seeded literals present in
 * every known surface: #text nodes, input/attribute values, select/textarea,
 * leak-prone attributes, and CSS url() tokens.
 */
function seededFullSnapshot(populated: boolean) {
  const cardText = SEEDED_PII[0]!;
  const jwt = SEEDED_PII[1]!;
  const email = SEEDED_PII[2]!;
  const password = SEEDED_PII[3]!;
  const ssn = SEEDED_PII[4]!;
  const plainName = SEEDED_PII[5]!;
  const phone = SEEDED_PII[6]!;
  const customSecret = SEEDED_PII[7]!;
  const cssToken = SEEDED_PII[8]!;
  return {
    type: FULL,
    timestamp: 1000,
    data: {
      node: {
        type: 1,
        childNodes: [
          // #text node carrying a card number → pattern-masked.
          { type: 3, textContent: populated ? cardText : '', id: 10 },
          // <input value> + data-* both carrying a JWT → both stripped.
          {
            type: 2,
            tagName: 'input',
            attributes: { type: 'text', value: populated ? jwt : '', 'data-token': jwt },
            childNodes: [],
            id: 11,
          },
          // password input value → stripped by the allowlist.
          {
            type: 2,
            tagName: 'input',
            attributes: { type: 'password', value: password, name: 'pw' },
            childNodes: [],
            id: 12,
          },
          // hidden input SSN value → stripped.
          {
            type: 2,
            tagName: 'input',
            attributes: { type: 'hidden', value: ssn, name: 'ssn' },
            childNodes: [],
            id: 19,
          },
          // <textarea> email via textContent (pattern-masked) + attrs (stripped).
          {
            type: 2,
            tagName: 'textarea',
            attributes: { placeholder: email, title: email, 'aria-label': email },
            childNodes: [{ type: 3, textContent: populated ? email : '', id: 14 }],
            id: 13,
          },
          // <select><option> PII via the option value attribute → stripped.
          {
            type: 2,
            tagName: 'select',
            attributes: { name: 'card-select' },
            childNodes: [
              {
                type: 2,
                tagName: 'option',
                attributes: { value: cardText, selected: 'true' },
                childNodes: [{ type: 3, textContent: 'Saved card', id: 16 }],
                id: 15,
              },
            ],
            id: 17,
          },
          // <a href> with a PII query string → query stripped.
          {
            type: 2,
            tagName: 'a',
            attributes: { href: `https://app/profile?email=${email}&jwt=${jwt}` },
            childNodes: [],
            id: 18,
          },
          // Non-pattern PII in #text leaves → VISIBLE (selective masking).
          { type: 3, textContent: populated ? plainName : '', id: 20 },
          { type: 3, textContent: populated ? phone : '', id: 21 },
          {
            type: 2,
            tagName: 'div',
            attributes: { class: 'note' },
            childNodes: [{ type: 3, textContent: populated ? customSecret : '', id: 23 }],
            id: 22,
          },
          // inline `style` carrying a url() exfil query token → stripped.
          {
            type: 2,
            tagName: 'div',
            attributes: { style: `background:url(https://t.example.com?token=${cssToken})` },
            childNodes: [],
            id: 24,
          },
          // `_cssText` carrying a url() exfil query token (quoted) → stripped.
          {
            type: 2,
            tagName: 'style',
            attributes: { _cssText: `.x{background:url("/img.png?k=${cssToken}")}` },
            childNodes: [],
            id: 25,
          },
        ],
        id: 1,
      },
    },
  };
}

function assertMasked(decompressed: string) {
  for (const literal of MUST_MASK) {
    expect(decompressed.includes(literal)).toBe(false);
  }
}

function assertVisible(decompressed: string) {
  for (const literal of VISIBLE_TEXT) {
    expect(decompressed.includes(literal)).toBe(true);
  }
}

describe('REPLAY-04 golden-file selective masking', () => {
  it('recorder pipeline applies the scrub unless the kill-switch is on', async () => {
    const events = [seededFullSnapshot(true)];
    // Drive the recorder's internal buffer through capture → scrub → compress.
    let emit: ((e: unknown, isCheckout?: boolean) => void) | undefined;
    const recWired = createReplayRecorder({
      importRrweb: async () => ({
        record: (o: Record<string, unknown>) => {
          emit = o['emit'] as typeof emit;
          return () => undefined;
        },
      }),
      now: () => 0,
      gzip: testGzip,
    });
    recWired.start(30);
    await Promise.resolve();
    await Promise.resolve();
    for (const e of events) emit!(e, true);
    recWired.freeze();
    const capture = await recWired.takeFrozen();
    expect(capture).not.toBeNull();
    const decompressed = gunzipSync(Buffer.from(capture!.bytes)).toString('utf8');
    // Ordinary UI text is present either way (selective masking never touches it).
    assertVisible(decompressed);
    if (REDACTION_DISABLED) {
      // ⚠ TEMP: kill-switch ON → the recorder skips the scrub (raw passthrough).
      // The scrub LOGIC itself stays covered by the direct-scrub tests below.
      expect(decompressed).toContain(SEEDED_PII[0]!); // card present, unscrubbed
    } else {
      assertMasked(decompressed);
    }
  });

  it('populated-field checkout snapshot masks pattern PII (rrweb #1385 regression)', () => {
    const scrubbed = scrubReplayEvents([seededFullSnapshot(true)]);
    const decompressed = JSON.stringify(scrubbed);
    assertMasked(decompressed);
    assertVisible(decompressed);
  });

  it('strips leak-prone attributes (value/placeholder/title/alt/aria-label/data-*) entirely', () => {
    const scrubbed = scrubReplayEvents([seededFullSnapshot(true)]);
    const json = JSON.stringify(scrubbed);
    expect(json).not.toContain('data-token');
    expect(json).not.toContain('placeholder');
    expect(json).not.toContain('aria-label');
    // href is kept (structural) but its PII query string is stripped.
    expect(json).toContain('https://app/profile');
    expect(json).not.toContain('?email=');
  });

  it('masked pattern PII becomes a redaction marker, not the raw value', () => {
    const scrubbed = scrubReplayEvents([seededFullSnapshot(true)]);
    const json = JSON.stringify(scrubbed);
    // The card/email text nodes are rewritten to the [REDACTED:*] marker.
    expect(json).toMatch(/\[REDACTED:[A-Z]+\]/);
  });

  it('CSS url() query tokens are stripped from style/_cssText (CR-03)', () => {
    const scrubbed = scrubReplayEvents([seededFullSnapshot(true)]);
    const json = JSON.stringify(scrubbed);
    expect(json).not.toContain('csstok_SECRET_4827');
    expect(json).not.toContain('?token=');
    expect(json).not.toContain('?k=');
    // …but the url() structure / host path is preserved (attribute not dropped).
    expect(json).toContain('url(');
    expect(json).toContain('https://t.example.com');
    expect(json).toContain('/img.png');
  });
});
