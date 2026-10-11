// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// REPLAY-04 — zero-leak masking gate (HIGHEST-LIABILITY GATE).
//
// Policy (spec 2026-10-11, "Web masking". It matches mobile and applies to bug
// reports and error replays alike):
//   - every form input value is masked (rrweb maskAllInputs, enforced again by
//     the scrub on Input events), and form state (checked/selected) is dropped;
//   - elements registered as sensitive are blocked (never serialized);
//   - card numbers, JWTs, bearer tokens, SSNs and emails are removed from every
//     string the replay carries; leak-prone attributes and CSS url() query
//     strings are stripped;
//   - ordinary page text stays readable. Free-text PII outside inputs is the
//     host's to mark sensitive, the standard session-replay posture.
// This file must fail if any input value or pattern match leaves the browser.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { record } from 'rrweb';
import { BEARER_PATTERN_SOURCE, scrubReplayEvents } from '../../../src/capture/replay/scrub.js';
import { createReplayRecorder } from '../../../src/capture/replay/recorder.js';
import {
  buildRecordOptions,
  MASK_PLACEHOLDER,
  REDACTION_DISABLED,
  RR_BLOCK_CLASS,
  RR_MASK_CLASS,
} from '../../../src/capture/replay/mask-mapping.js';
import { SENSITIVE_ATTR } from '../../../src/sensitive/registry.js';

// jsdom Blob lacks .stream() → inject a node:zlib gzip that round-trips with gunzipSync.
const testGzip = async (input: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(gzipSync(Buffer.from(input)));

const BEARER_SECRET = 'sk_live_51HxyzSECRETtoken';

// Literals seeded into the fixtures. Indices are referenced below.
const SEEDED_PII = [
  '4111111111111111', // [0] Luhn-valid Visa test card (text node → pattern-masked)
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123signature', // [1] JWT
  'victim@example.com', // [2] email (text node → pattern-masked; attrs → stripped)
  'hunter2secretpassword', // [3] password input value → stripped
  '123-45-6789', // [4] SSN hidden input value → stripped
  'John Smith', // [5] plain name in #text → VISIBLE
  '(415) 555-0132', // [6] phone in #text → VISIBLE (not a masked pattern)
  'hunter2-not-a-jwt-but-secret', // [7] custom free-text secret in #text → VISIBLE
  'csstok_SECRET_4827', // [8] CSS url() query token → stripped (CR-03)
  'typed-free-text-value', // [9] a value typed into a plain text input → masked
  BEARER_SECRET, // [10] bearer token in text → removed
];
const TYPED = SEEDED_PII[9]!;

// Input values, pattern PII and CSS tokens: these MUST be masked or stripped.
const MUST_MASK = [0, 1, 2, 3, 4, 8, 9, 10].map((i) => SEEDED_PII[i]!);
// Non-pattern free text in #text nodes: VISIBLE by design (watchable replay).
const VISIBLE_TEXT = [5, 6, 7].map((i) => SEEDED_PII[i]!);

const FULL = 2; // EventType.FullSnapshot
const INCR = 3; // EventType.IncrementalSnapshot
const MUTATION = 0; // IncrementalSource.Mutation
const INPUT = 5; // IncrementalSource.Input

/**
 * Build an rrweb-style full-snapshot event with the seeded literals present in
 * every known surface: #text nodes, input/attribute values, select/textarea,
 * leak-prone attributes, form state and CSS url() tokens.
 */
function seededFullSnapshot(populated: boolean) {
  const [cardText, jwt, email, password, ssn, plainName, phone, customSecret, cssToken] = SEEDED_PII as [
    string, string, string, string, string, string, string, string, string,
  ];
  return {
    type: FULL,
    timestamp: 1000,
    data: {
      node: {
        type: 1,
        childNodes: [
          { type: 3, textContent: populated ? cardText : '', id: 10 },
          { type: 2, tagName: 'input', attributes: { type: 'text', value: populated ? jwt : '', 'data-token': jwt }, childNodes: [], id: 11 },
          { type: 2, tagName: 'input', attributes: { type: 'password', value: password, name: 'pw' }, childNodes: [], id: 12 },
          { type: 2, tagName: 'input', attributes: { type: 'hidden', value: ssn, name: 'ssn' }, childNodes: [], id: 19 },
          {
            type: 2, tagName: 'textarea', attributes: { placeholder: email, title: email, 'aria-label': email },
            childNodes: [{ type: 3, textContent: populated ? email : '', id: 14 }], id: 13,
          },
          {
            type: 2, tagName: 'select', attributes: { name: 'card-select' },
            childNodes: [{
              type: 2, tagName: 'option', attributes: { value: cardText, selected: 'true' },
              childNodes: [{ type: 3, textContent: 'Saved card', id: 16 }], id: 15,
            }],
            id: 17,
          },
          { type: 2, tagName: 'a', attributes: { href: `https://app/profile?email=${email}&jwt=${jwt}` }, childNodes: [], id: 18 },
          { type: 3, textContent: populated ? plainName : '', id: 20 },
          { type: 3, textContent: populated ? phone : '', id: 21 },
          { type: 2, tagName: 'div', attributes: { class: 'note' }, childNodes: [{ type: 3, textContent: populated ? customSecret : '', id: 23 }], id: 22 },
          { type: 2, tagName: 'div', attributes: { style: `background:url(https://t.example.com?token=${cssToken})` }, childNodes: [], id: 24 },
          { type: 2, tagName: 'style', attributes: { _cssText: `.x{background:url("/img.png?k=${cssToken}")}` }, childNodes: [], id: 25 },
          { type: 3, textContent: populated ? `Authorization: Bearer ${BEARER_SECRET}` : '', id: 26 },
          { type: 2, tagName: 'input', attributes: { type: 'checkbox', checked: true, name: 'agree' }, childNodes: [], id: 27 },
        ],
        id: 1,
      },
    },
  };
}

/** Incremental events as rrweb emits them after the full snapshot. */
function seededIncrementals() {
  return [
    // Input events: a typed value and a ticked checkbox. maskAllInputs masks the
    // value at capture; the scrub enforces it whatever rrweb did.
    { type: INCR, timestamp: 1100, data: { source: INPUT, id: 11, text: TYPED, isChecked: false } },
    { type: INCR, timestamp: 1150, data: { source: INPUT, id: 27, text: 'on', isChecked: true } },
    // Mutation: a text change carrying a bearer token, and an attribute change
    // carrying a typed value, form state and a style diff object with a JWT.
    {
      type: INCR,
      timestamp: 1200,
      data: {
        source: MUTATION,
        texts: [{ id: 20, value: `Authorization: Bearer ${BEARER_SECRET}` }],
        attributes: [{
          id: 11,
          attributes: {
            value: TYPED,
            checked: true,
            style: { 'background-image': `url(https://t.example.com/a.png?jwt=${SEEDED_PII[1]!})` },
          },
        }],
        removes: [],
        adds: [],
      },
    },
  ];
}

function assertMasked(decompressed: string) {
  for (const literal of MUST_MASK) expect(decompressed, literal).not.toContain(literal);
}

function assertVisible(decompressed: string) {
  for (const literal of VISIBLE_TEXT) expect(decompressed, literal).toContain(literal);
}

describe('REPLAY-04 golden-file masking', () => {
  it('recorder pipeline masks and scrubs (masking is on)', async () => {
    expect(REDACTION_DISABLED).toBe(false);
    const events = [seededFullSnapshot(true), ...seededIncrementals()];
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
    for (const e of events) emit!(e, e.type === FULL);
    recWired.freeze();
    const capture = await recWired.takeFrozen();
    expect(capture).not.toBeNull();
    const decompressed = gunzipSync(Buffer.from(capture!.bytes)).toString('utf8');
    assertVisible(decompressed);
    assertMasked(decompressed);
  });

  it('populated-field checkout snapshot masks pattern PII (rrweb #1385 regression)', () => {
    const decompressed = JSON.stringify(scrubReplayEvents([seededFullSnapshot(true)]));
    assertMasked(decompressed);
    assertVisible(decompressed);
  });

  it('strips leak-prone attributes (value/placeholder/title/alt/aria-label/data-*) entirely', () => {
    const json = JSON.stringify(scrubReplayEvents([seededFullSnapshot(true)]));
    expect(json).not.toContain('data-token');
    expect(json).not.toContain('placeholder');
    expect(json).not.toContain('aria-label');
    expect(json).toContain('https://app/profile');
    expect(json).not.toContain('?email=');
  });

  it('masked pattern PII becomes a redaction marker, not the raw value', () => {
    const json = JSON.stringify(scrubReplayEvents([seededFullSnapshot(true)]));
    expect(json).toMatch(/\[REDACTED:[A-Z]+\]/);
  });

  it('CSS url() query tokens are stripped from style/_cssText (CR-03)', () => {
    const json = JSON.stringify(scrubReplayEvents([seededFullSnapshot(true)]));
    expect(json).not.toContain('csstok_SECRET_4827');
    expect(json).not.toContain('?token=');
    expect(json).not.toContain('?k=');
    expect(json).toContain('url(');
    expect(json).toContain('https://t.example.com');
    expect(json).toContain('/img.png');
  });

  it('masks the value every Input event carries, whatever rrweb did (maskAllInputs, enforced)', () => {
    const json = JSON.stringify(scrubReplayEvents(seededIncrementals()));
    expect(json).not.toContain(TYPED);
    expect(json).toContain(`"text":"${MASK_PLACEHOLDER}"`);
    expect(json).not.toMatch(/"isChecked":true/);
  });

  it('drops form state: no checked or selected attribute survives', () => {
    const json = JSON.stringify(scrubReplayEvents([seededFullSnapshot(true), ...seededIncrementals()]));
    expect(json).not.toMatch(/"(checked|selected)":/);
  });

  it('removes bearer tokens from text everywhere', () => {
    const json = JSON.stringify(scrubReplayEvents([seededFullSnapshot(true), ...seededIncrementals()]));
    expect(json).not.toContain(BEARER_SECRET);
    expect(json).toContain('Authorization: [REDACTED]');
  });

  it('scrubs style diff objects on attribute mutations', () => {
    const json = JSON.stringify(scrubReplayEvents(seededIncrementals()));
    expect(json).not.toContain(SEEDED_PII[1]!);
    expect(json).not.toContain('?jwt=');
    expect(json).toContain('url(https://t.example.com/a.png)');
  });

  it('scrubs prioritized style diff values without losing their CSS priority or removal markers', () => {
    const event = { type: INCR, data: { source: MUTATION, attributes: [{ id: 24, attributes: {
      style: {
        'background-image': ['url(/private.png?token=style-secret)', 'important'],
        content: [`Authorization: Bearer ${BEARER_SECRET}`, 'important'],
        color: false,
      },
    } }] } };
    const original = JSON.stringify(event);
    const [scrubbed] = scrubReplayEvents([event]);
    expect(scrubbed!.data.attributes[0]!.attributes.style).toEqual({
      'background-image': ['url(/private.png)', 'important'],
      content: ['Authorization: [REDACTED]', 'important'],
      color: false,
    });
    expect(JSON.stringify(event)).toBe(original);
  });

  it('uses the shared bearer pattern (protocol data/redaction-patterns.json)', () => {
    const shared = JSON.parse(
      readFileSync(new NodeURL('../../../../protocol/data/redaction-patterns.json', import.meta.url), 'utf8'),
    ) as { patterns: Array<{ id: string; regex: string }> };
    expect(`(?i)${BEARER_PATTERN_SOURCE}`).toBe(shared.patterns.find((p) => p.id === 'bearer')!.regex);
  });
});

describe('record options (spec 2026-10-11, "Web masking")', () => {
  it('masks every input, blocks sensitive elements and leaves ordinary text unmasked', () => {
    const opts = buildRecordOptions({ durationSec: 30, emit: () => undefined, blockSelector: `[${SENSITIVE_ATTR}]` });
    expect(opts.maskAllInputs).toBe(true);
    expect(opts.maskInputFn?.('hunter2')).toBe(MASK_PLACEHOLDER);
    expect(opts.maskTextSelector).toBeUndefined();
    expect(opts.maskTextClass).toBe(RR_MASK_CLASS);
    expect(opts.blockClass).toBe(RR_BLOCK_CLASS);
    expect(opts.blockSelector).toBe('[data-everframe-sensitive]');
  });

  it('the recorder hands rrweb the sensitive block selector', async () => {
    let seen: Record<string, unknown> | undefined;
    const rec = createReplayRecorder({
      importRrweb: async () => ({
        record: (o: Record<string, unknown>) => {
          seen = o;
          return () => undefined;
        },
      }),
    });
    rec.start(30);
    await vi.waitFor(() => expect(seen).toBeDefined());
    expect(seen!['blockSelector']).toBe(`[${SENSITIVE_ATTR}]`);
    expect(seen!['maskAllInputs']).toBe(true);
    expect(seen!['maskTextSelector']).toBeUndefined();
    rec.stop();
  });
});

describe('real rrweb, end to end', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const type = (selector: string, value: string): void => {
    const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  it('ships no input value and no pattern match, and keeps ordinary text readable', async () => {
    const jwt = SEEDED_PII[1]!;
    document.body.innerHTML = `
      <p>Welcome back, John Smith</p>
      <p>Card on file 4111 1111 1111 1111</p>
      <p>Contact victim@example.com</p>
      <p>Session ${jwt}</p>
      <p>Authorization: Bearer ${BEARER_SECRET}</p>
      <section ${SENSITIVE_ATTR}><span>Sensitive-subtree-secret</span></section>
      <input id="name" type="text">
      <input id="pw" type="password">
      <input id="email" type="email">
      <input id="agree" type="checkbox">
      <textarea id="notes"></textarea>
      <select id="plan"><option value="basic">Basic</option><option value="secret-plan-value">Gold</option></select>`;
    // Real rrweb (the recorder's own lazy import). No sensitiveElements dep: the
    // block selector alone must keep the sensitive section out.
    const rec = createReplayRecorder({ gzip: testGzip });
    try {
      rec.start(30);
      await vi.waitFor(() => expect(rec.__diagnostics().recording).toBe(true));
      type('#name', TYPED);
      type('#pw', SEEDED_PII[3]!);
      type('#email', 'typed@example.org');
      type('#notes', 'private notes typed by the user');
      const plan = document.querySelector<HTMLSelectElement>('#plan')!;
      plan.value = 'secret-plan-value';
      plan.dispatchEvent(new Event('change', { bubbles: true }));
      const agree = document.querySelector<HTMLInputElement>('#agree')!;
      agree.checked = true;
      agree.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0)); // flush rrweb's mutation observer
      // A checkout with every field populated: the rrweb #1385 path.
      record.takeFullSnapshot(true);
      rec.freeze();
      const capture = await rec.takeFrozen();
      expect(capture).not.toBeNull();
      const json = gunzipSync(Buffer.from(capture!.bytes)).toString('utf8');
      for (const secret of [
        TYPED, SEEDED_PII[3]!, 'typed@example.org', 'private notes typed by the user', 'secret-plan-value',
        '4111 1111 1111 1111', 'victim@example.com', jwt, BEARER_SECRET, 'Sensitive-subtree-secret',
      ]) {
        expect(json, secret).not.toContain(secret);
      }
      expect(json).not.toMatch(/"isChecked":true/);
      expect(json).not.toMatch(/"(checked|selected)":/);
      expect(json).toContain('Welcome back, John Smith');
    } finally {
      rec.stop();
    }
  });

  it('blocks late-mounted and newly marked sensitive subtrees on mutations and checkouts', async () => {
    document.body.innerHTML = '<p>Public content stays readable</p><section id="later"></section>';
    const rec = createReplayRecorder({ gzip: testGzip });
    try {
      rec.start(30);
      await vi.waitFor(() => expect(rec.__diagnostics().recording).toBe(true));
      const late = document.createElement('section');
      late.setAttribute(SENSITIVE_ATTR, '');
      late.innerHTML = '<span>late-mounted-private-secret</span>';
      document.body.append(late);
      const later = document.querySelector('#later')!;
      later.setAttribute(SENSITIVE_ATTR, '');
      later.innerHTML = '<span>newly-marked-private-secret</span>';
      const masked = document.createElement('p');
      masked.className = RR_MASK_CLASS;
      masked.textContent = 'host-mask-private-secret';
      document.body.append(masked);
      await new Promise((resolve) => setTimeout(resolve, 0));
      record.takeFullSnapshot(true);
      rec.freeze();
      const capture = await rec.takeFrozen();
      expect(capture).not.toBeNull();
      const json = gunzipSync(Buffer.from(capture!.bytes)).toString('utf8');
      for (const secret of ['late-mounted-private-secret', 'newly-marked-private-secret', 'host-mask-private-secret']) {
        expect(json, secret).not.toContain(secret);
      }
      expect(json).toContain('Public content stays readable');
    } finally {
      rec.stop();
    }
  });

});
