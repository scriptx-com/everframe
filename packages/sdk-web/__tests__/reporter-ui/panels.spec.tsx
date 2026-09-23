// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent, act } from '@testing-library/react';
import { LogsPanel } from '../../src/reporter-ui/panels/LogsPanel.js';
import { NetworkPanel } from '../../src/reporter-ui/panels/NetworkPanel.js';
import { MetadataPanel } from '../../src/reporter-ui/panels/MetadataPanel.js';
import type { LogEntry, NetworkEntry } from '@everframe/sdk-core';

afterEach(() => cleanup());

// CollapsiblePanel starts closed; expand via the header disclosure button so
// children render. Returns nothing — caller asserts on the now-mounted body.
function expand(getByTestId: (id: string) => HTMLElement, panelTestId: string): void {
  fireEvent.click(getByTestId(`${panelTestId}-disclosure`));
}

describe('Advanced panels', () => {
  it('LogsPanel: per-row × button toggles redaction class via parent state', async () => {
    const logs: LogEntry[] = [{ level: 'log', message: 'msg-0', timestamp: 1700000000000 }];
    const onToggleRedact = vi.fn();
    let redacted = new Set<number>();
    const { rerender, getByTestId } = render(
      <LogsPanel
        logs={logs}
        included={true}
        onToggle={() => undefined}
        redacted={redacted}
        onToggleRedact={onToggleRedact}
      />,
    );
    expand(getByTestId, 'logs-panel');
    const btn = getByTestId('log-redact-0');
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(onToggleRedact).toHaveBeenCalledWith(0);
    redacted = new Set([0]);
    rerender(
      <LogsPanel
        logs={logs}
        included={true}
        onToggle={() => undefined}
        redacted={redacted}
        onToggleRedact={onToggleRedact}
      />,
    );
    // Panel is still open from the first expand — useState in CollapsiblePanel
    // survives rerender — so the row is still in the DOM.
    const row = getByTestId('log-row-0');
    expect(row.className).toContain('everframe-row-redacted');
  });

  it('NetworkPanel: renders rows when expanded; no per-row redact (display-only)', () => {
    const entries: NetworkEntry[] = [
      {
        method: 'GET',
        url: 'https://api.example.com/endpoint',
        startedAt: 0,
        status: 200,
        durationMs: 100,
      },
    ];
    const { getByTestId, queryByTestId } = render(
      <NetworkPanel entries={entries} included={true} onToggle={() => undefined} />,
    );
    expand(getByTestId, 'network-panel');
    expect(getByTestId('net-row-0')).toBeInTheDocument();
    // Per-row redact dropped intentionally — only the artifact-level switch
    // controls inclusion (Phase 06.3 reporter UX cleanup).
    expect(queryByTestId('net-redact-0')).toBeNull();
  });

  it('MetadataPanel: renders OS / locale / timezone rows when expanded', () => {
    const meta = {
      os: 'macOS',
      osVersion: '14.2.1',
      screenSize: { width: 1920, height: 1080 },
      pixelRatio: 2,
      locale: 'en-US',
      timezone: 'America/New_York',
    };
    const { getByText, getByTestId } = render(<MetadataPanel meta={meta} />);
    expand(getByTestId, 'metadata-panel');
    expect(getByText('macOS')).toBeInTheDocument();
    expect(getByText('en-US')).toBeInTheDocument();
    expect(getByText('America/New_York')).toBeInTheDocument();
  });

  it('Toggle primitive swaps aria-label between Include/Exclude (verb-pair lock)', () => {
    const baseMeta = {
      os: 'macOS',
      osVersion: '14',
      screenSize: { width: 1, height: 1 },
      pixelRatio: 1,
      locale: 'en',
      timezone: 'UTC',
    };
    // MetadataPanel is locked-on; assert via Toggle's aria-label not visible text.
    const { container } = render(<MetadataPanel meta={baseMeta} />);
    const sw = container.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(sw).not.toBeNull();
    expect(sw.getAttribute('aria-label')).toBe('Include');
    expect(sw.disabled).toBe(true);
  });
});
