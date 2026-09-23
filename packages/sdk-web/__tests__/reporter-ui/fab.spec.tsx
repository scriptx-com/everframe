// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ReporterFab } from '../../src/reporter-ui/ReporterFab';

afterEach(() => cleanup());

describe('ReporterFab', () => {
  it('renders an accessible button and fires onOpen', () => {
    const onOpen = vi.fn();
    render(<ReporterFab unreadCount={0} onOpen={onOpen} />);
    const btn = screen.getByRole('button', { name: 'Your reports' });
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(btn.querySelector('.everframe-fab-dot')).toBeNull();
  });

  it('shows the unread dot and announces the count when unread > 0', () => {
    render(<ReporterFab unreadCount={3} onOpen={() => {}} />);
    const btn = screen.getByRole('button', { name: 'Your reports — 3 unread' });
    expect(btn.querySelector('.everframe-fab-dot')).not.toBeNull();
  });
});
