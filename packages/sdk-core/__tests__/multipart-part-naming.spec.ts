// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { buildMultipart } from '../src/transport/multipart.js';
import type { ReportEnvelope } from '@everframe/protocol';

/** Minimal envelope stub — buildMultipart only reads `.attachments` and
 *  serializes the rest verbatim. */
const envelopeStub = { attachments: [] } as unknown as ReportEnvelope;

const bytes = new Uint8Array([1, 2, 3]);

describe('buildMultipart — screenshot-N part naming', () => {
  it('classifies numbered screenshot parts by prefix', async () => {
    const { envelopeBytes } = await buildMultipart({
      envelope: envelopeStub,
      attachments: [
        { name: 'screenshot', bytes, contentType: 'image/png' },
        { name: 'screenshot-2', bytes, contentType: 'image/png' },
        { name: 'annotated-screenshot-3', bytes, contentType: 'image/webp' },
        { name: 'session-replay', bytes, contentType: 'application/octet-stream' },
        { name: 'mystery-part', bytes, contentType: 'application/octet-stream' },
      ],
    });
    const finalEnvelope = JSON.parse(new TextDecoder().decode(envelopeBytes)) as {
      attachments: Array<{ partName: string; kind: string }>;
    };
    const kinds = Object.fromEntries(
      finalEnvelope.attachments.map((a) => [a.partName, a.kind]),
    );
    expect(kinds['screenshot']).toBe('screenshot');
    expect(kinds['screenshot-2']).toBe('screenshot');
    expect(kinds['annotated-screenshot-3']).toBe('annotated-screenshot');
    expect(kinds['session-replay']).toBe('session-replay');
    expect(kinds['mystery-part']).toBe('other');
  });

  it('does NOT classify lookalike names (suffix must be numeric)', async () => {
    const { envelopeBytes } = await buildMultipart({
      envelope: envelopeStub,
      attachments: [{ name: 'screenshot-extra-notes', bytes, contentType: 'text/plain' }],
    });
    const finalEnvelope = JSON.parse(new TextDecoder().decode(envelopeBytes)) as {
      attachments: Array<{ partName: string; kind: string }>;
    };
    expect(finalEnvelope.attachments[0]!.kind).toBe('other');
  });
});
