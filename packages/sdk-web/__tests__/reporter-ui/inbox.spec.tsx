// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { InboxDialog } from '../../src/reporter-ui/inbox/InboxDialog';
import { ThreadView } from '../../src/reporter-ui/inbox/ThreadView';
import { MESSAGE_BODY_MAX } from '@everframe/sdk-core';
import type { ThreadClientState, ThreadSummary } from '@everframe/sdk-core';

afterEach(() => cleanup());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const T1: ThreadSummary = {
  id: 't1',
  status: 'open' as const,
  reportTitle: 'Login crash',
  createdAt: '2026-08-01T00:00:00.000Z',
  lastMessageAt: null,
  unreadCount: 2,
};
const T2: ThreadSummary = {
  id: 't2',
  status: 'closed' as const,
  reportTitle: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  lastMessageAt: null,
  unreadCount: 0,
};

function fakeFacade(threads: ThreadSummary[] = [T1, T2], stateOver: Partial<ThreadClientState> = {}) {
  const state: ThreadClientState = {
    enabled: true,
    readOnly: false,
    threads,
    unreadCount: 2,
    pending: [],
    cooldownUntilMs: null,
    ...stateOver,
  };
  return {
    list: () => threads,
    get: vi.fn(async () => null),
    reply: vi.fn(async () => {}),
    retryMessage: vi.fn(async () => {}),
    markRead: vi.fn(async () => {}),
    delete: vi.fn(async () => true),
    unreadCount: () => state.unreadCount,
    subscribe: vi.fn(() => () => {}),
    refresh: vi.fn(async () => {}),
    getState: () => state, // part of the Task 7 facade
  };
}

describe('InboxDialog list view', () => {
  it('renders one row per thread with title fallback, status chip, and unread dot', () => {
    render(<InboxDialog open onClose={() => {}} threads={fakeFacade() as never} onNewReport={() => {}} />);
    expect(screen.getByText('Login crash')).toBeInTheDocument();
    expect(screen.getByText(/Report from/)).toBeInTheDocument(); // null title fallback
    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(document.querySelectorAll('.everframe-inbox-unread-dot')).toHaveLength(1);
  });

  it('shows the empty state with a New report button', () => {
    const onNewReport = vi.fn();
    render(<InboxDialog open onClose={() => {}} threads={fakeFacade([]) as never} onNewReport={onNewReport} />);
    expect(screen.getByText('No reports yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New report' }));
    expect(onNewReport).toHaveBeenCalled();
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <InboxDialog open={false} onClose={() => {}} threads={fakeFacade() as never} onNewReport={() => {}} />,
    );
    expect(container.querySelector('.everframe-modal')).toBeNull();
  });
});

describe('InboxDialog thread view', () => {
  it('renders message bodies as escaped text with no linkification', async () => {
    const facade = fakeFacade();
    (facade.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 't1', status: 'open', reportTitle: 'Login crash',
      messages: [
        { id: 'm1', authorKind: 'team', authorName: 'Acme Support', body: '<img src=x onerror=alert(1)>', createdAt: '2026-08-01T01:00:00.000Z' },
        { id: 'm2', authorKind: 'team', authorName: 'Acme Support', body: 'see https://evil.example', createdAt: '2026-08-01T01:01:00.000Z' },
      ],
      pending: [], truncation: false, fresh: true,
    });
    render(<InboxDialog open onClose={() => {}} threads={facade as never} onNewReport={() => {}} />);
    fireEvent.click(await screen.findByText('Login crash'));
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('.everframe-inbox-msg img')).toBeNull();
    expect(document.querySelector('.everframe-inbox-msg a')).toBeNull();
  });

  it('shows the author name (Support fallback when null) for team/system messages, and no name for reporter messages', async () => {
    const facade = fakeFacade();
    (facade.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 't1', status: 'open', reportTitle: 'Login crash',
      messages: [
        { id: 'm1', authorKind: 'team', authorName: null, body: 'hi there', createdAt: '2026-08-01T01:00:00.000Z' },
        { id: 'm2', authorKind: 'team', authorName: 'Acme Support', body: 'hello', createdAt: '2026-08-01T01:01:00.000Z' },
        { id: 'm3', authorKind: 'reporter', authorName: null, body: 'thanks', createdAt: '2026-08-01T01:02:00.000Z' },
      ],
      pending: [], truncation: false, fresh: true,
    });
    render(<InboxDialog open onClose={() => {}} threads={facade as never} onNewReport={() => {}} />);
    fireEvent.click(await screen.findByText('Login crash'));
    expect(await screen.findByText('Support')).toBeInTheDocument();
    expect(screen.getByText('Acme Support')).toBeInTheDocument();
    const mine = document.querySelectorAll('.everframe-inbox-msg-mine');
    expect(mine).toHaveLength(1);
    expect(mine[0]?.querySelector('.everframe-inbox-msg-author')).toBeNull();
  });

  it('caps the composer at MESSAGE_BODY_MAX, disables Send while empty, and sends + clears on click', async () => {
    const facade = fakeFacade();
    (facade.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 't1', status: 'open', reportTitle: 'Login crash', messages: [], pending: [], truncation: false, fresh: true,
    });
    render(<InboxDialog open onClose={() => {}} threads={facade as never} onNewReport={() => {}} />);
    fireEvent.click(await screen.findByText('Login crash'));
    const textarea = (await screen.findByPlaceholderText('Write a reply…')) as HTMLTextAreaElement;
    expect(textarea).toHaveAttribute('maxLength', String(MESSAGE_BODY_MAX));
    const sendBtn = screen.getByRole('button', { name: 'Send' });
    expect(sendBtn).toBeDisabled();
    fireEvent.change(textarea, { target: { value: '  hello there  ' } });
    expect(sendBtn).not.toBeDisabled();
    fireEvent.click(sendBtn);
    expect(facade.reply).toHaveBeenCalledWith('t1', '  hello there  ');
    expect(textarea.value).toBe('');
  });

  it('renders a Sending… marker for a pending send and a Retry button for a failed one', async () => {
    const facade = fakeFacade();
    (facade.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 't1', status: 'open', reportTitle: 'Login crash', messages: [],
      pending: [
        { localId: 'local-1', threadId: 't1', body: 'still sending', state: 'sending', attempts: 0, createdAt: '2026-08-01T01:00:00.000Z' },
        { localId: 'local-2', threadId: 't1', body: 'gave up', state: 'failed', attempts: 3, createdAt: '2026-08-01T01:01:00.000Z' },
      ],
      truncation: false, fresh: true,
    });
    render(<InboxDialog open onClose={() => {}} threads={facade as never} onNewReport={() => {}} />);
    fireEvent.click(await screen.findByText('Login crash'));
    expect(await screen.findByText('Sending…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(facade.retryMessage).toHaveBeenCalledWith('local-2');
  });

  // Finding 3 (round 10, PR review): retryMessage() (sdk-core) now no-ops
  // on a read-only/closed thread, but the built-in UI used to render Retry
  // independent of `closed`/`readOnly` — a click still fired a POST-
  // issuing call at the facade layer regardless. A read-only/closed thread
  // must not offer Retry at all: the failed bubble and its text stay
  // visible, but with no button to click.
  it('does not render an enabled Retry on a closed/read-only thread — the failed message stays visible without one', async () => {
    const facade = fakeFacade([T1, T2], { readOnly: true });
    (facade.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 't1', status: 'closed', reportTitle: 'Login crash', messages: [],
      pending: [
        { localId: 'local-2', threadId: 't1', body: 'gave up', state: 'failed', attempts: 3, createdAt: '2026-08-01T01:01:00.000Z' },
      ],
      truncation: false, fresh: true,
    });
    render(<ThreadView threads={facade as never} threadId="t1" onBack={() => {}} onNewReport={() => {}} />);
    expect(await screen.findByText('gave up')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByText(/Not sent\./)).toBeInTheDocument();
  });

  // Same guard, but for a thread that's closed WITHOUT the global readOnly
  // latch (e.g. a prior thread_closed 409) — Retry must still be withheld.
  it('does not render an enabled Retry on a closed thread even when the client is not globally read-only', async () => {
    const facade = fakeFacade([T1, T2], { readOnly: false });
    (facade.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 't1', status: 'closed', reportTitle: 'Login crash', messages: [],
      pending: [
        { localId: 'local-3', threadId: 't1', body: 'no longer welcome', state: 'failed', attempts: 4, createdAt: '2026-08-01T01:02:00.000Z' },
      ],
      truncation: false, fresh: true,
    });
    render(<ThreadView threads={facade as never} threadId="t1" onBack={() => {}} onNewReport={() => {}} />);
    expect(await screen.findByText('no longer welcome')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('replaces the composer with a closed notice for a closed thread, but keeps delete available', async () => {
    const facade = fakeFacade();
    (facade.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 't2', status: 'closed', reportTitle: null, messages: [], pending: [], truncation: false, fresh: true,
    });
    render(<InboxDialog open onClose={() => {}} threads={facade as never} onNewReport={() => {}} />);
    fireEvent.click(await screen.findByText(/Report from/));
    expect(await screen.findByText('This conversation is closed.')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Write a reply…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete this conversation' })).toBeInTheDocument();
  });

  it('disables the composer with a cooldown notice (not error-styled) while cooldownUntilMs is in the future', async () => {
    const facade = fakeFacade([T1, T2], { cooldownUntilMs: Date.now() + 30_000 });
    (facade.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 't1', status: 'open', reportTitle: 'Login crash', messages: [], pending: [], truncation: false, fresh: true,
    });
    render(<InboxDialog open onClose={() => {}} threads={facade as never} onNewReport={() => {}} />);
    fireEvent.click(await screen.findByText('Login crash'));
    const textarea = await screen.findByPlaceholderText('Write a reply…');
    expect(textarea).toBeDisabled();
    const notice = await screen.findByText("You're sending too fast — try again in a moment.");
    expect(notice.className).toBe('everframe-inbox-cooldown');
    expect(notice.className).not.toMatch(/error/);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  // Round-6 PR-review Finding 4 (MEDIUM): `cooldownActive` is derived from
  // `Date.now()` purely at render time, with no timer scheduled — a 429 from
  // `get()` can set the global cooldown deadline with no pending send, and
  // subsequent ETag-304 polls don't notify subscribers. Crossing the
  // deadline then changes no React state, so the composer/Send stay
  // disabled until an unrelated notification or a close/reopen. Verified
  // RED against pre-fix ThreadView.tsx (no scheduled timeout): the composer
  // remains disabled forever here since nothing calls `threads.subscribe`'s
  // callback and nothing else forces a re-render.
  it('re-enables the composer on its own once the cooldown deadline passes, with no further subscription notify', async () => {
    vi.useFakeTimers();
    try {
      const deadline = Date.now() + 5_000;
      const facade = fakeFacade([T1, T2], { cooldownUntilMs: deadline });
      (facade.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 't1', status: 'open', reportTitle: 'Login crash', messages: [], pending: [], truncation: false, fresh: true,
      });
      render(<ThreadView threads={facade as never} threadId="t1" onBack={() => {}} onNewReport={() => {}} />);
      // Flush the async `threads.get()` load (a real microtask — fake
      // macrotask timers don't affect it) without relying on findBy*'s
      // internal (real-timer-based) polling.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const textarea = screen.getByPlaceholderText('Write a reply…') as HTMLTextAreaElement;
      expect(textarea).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
      // Give the composer non-empty text so Send's disabled state reflects
      // ONLY `cooldownActive` from here on, not the separate `trimmedEmpty`
      // gate (jsdom's fireEvent bypasses the browser's native
      // disabled-element interaction block, so this is safe pre-re-enable).
      fireEvent.change(textarea, { target: { value: 'hello' } });
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
      // Exactly one subscription for the whole mount — established up front
      // so we can prove below that nothing calls it again.
      expect(facade.subscribe).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(5_000);
      });

      expect(textarea).not.toBeDisabled();
      expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled();
      // The re-enable came purely from the internally-scheduled timeout —
      // the facade's subscribe callback (the ONLY other thing that could
      // force a re-render here) was never invoked, and subscribe() itself
      // was never called a second time.
      expect(facade.subscribe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Finding 2 (round 9, PR review): retryMessage() (sdk-core) now defers
  // the actual POST while the send cooldown is active, but the built-in UI
  // left every failed bubble's Retry button enabled regardless — a click
  // still called threads.retryMessage() immediately, so the user could keep
  // firing (harmless post-fix, but still confusing/spammy) retries during a
  // cooldown the composer itself is visibly respecting. Disable Retry while
  // cooldownActive, and re-enable it once the existing cooldown timer (round
  // 6/7) fires — reusing the same deadline the composer already gates on.
  it('disables the Retry button on a failed bubble while the send cooldown is active, and re-enables it when the timer fires', async () => {
    vi.useFakeTimers();
    try {
      const deadline = Date.now() + 5_000;
      const facade = fakeFacade([T1, T2], { cooldownUntilMs: deadline });
      (facade.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 't1', status: 'open', reportTitle: 'Login crash', messages: [],
        pending: [
          { localId: 'local-2', threadId: 't1', body: 'gave up', state: 'failed', attempts: 3, createdAt: '2026-08-01T01:01:00.000Z' },
        ],
        truncation: false, fresh: true,
      });
      render(<ThreadView threads={facade as never} threadId="t1" onBack={() => {}} onNewReport={() => {}} />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const retryBtn = screen.getByRole('button', { name: 'Retry' });
      expect(retryBtn).toBeDisabled();

      act(() => {
        vi.advanceTimersByTime(5_000);
      });

      expect(retryBtn).not.toBeDisabled();
      fireEvent.click(retryBtn);
      expect(facade.retryMessage).toHaveBeenCalledWith('local-2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('delete confirm states the non-erasure copy exactly and, on confirm, deletes then returns to the list', async () => {
    const facade = fakeFacade();
    (facade.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 't1', status: 'open', reportTitle: 'Login crash', messages: [], pending: [], truncation: false, fresh: true,
    });
    render(<InboxDialog open onClose={() => {}} threads={facade as never} onNewReport={() => {}} />);
    fireEvent.click(await screen.findByText('Login crash'));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete this conversation' }));
    expect(
      await screen.findByText('Deletes this conversation for you. The report you sent is not deleted.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete conversation' }));
    await waitFor(() => expect(facade.delete).toHaveBeenCalledWith('t1'));
    // onBack() fired after delete() resolves — back at the list.
    expect(screen.queryByRole('button', { name: '← Your reports' })).toBeNull();
  });

  it('a failed delete shows a non-fatal retry notice and stays on the thread instead of navigating back', async () => {
    const facade = fakeFacade();
    (facade.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 't1', status: 'open', reportTitle: 'Login crash', messages: [], pending: [], truncation: false, fresh: true,
    });
    (facade.delete as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    render(<InboxDialog open onClose={() => {}} threads={facade as never} onNewReport={() => {}} />);
    fireEvent.click(await screen.findByText('Login crash'));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete this conversation' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete conversation' }));
    await waitFor(() => expect(facade.delete).toHaveBeenCalledWith('t1'));
    expect(await screen.findByText("Couldn't delete — try again.")).toBeInTheDocument();
    // Still on the thread view — did not navigate back to the list.
    expect(screen.getByRole('button', { name: '← Your reports' })).toBeInTheDocument();
  });

  it('shows a truncated notice when the thread detail reports older messages were dropped', async () => {
    const facade = fakeFacade();
    (facade.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 't1', status: 'open', reportTitle: 'Login crash', messages: [], pending: [], truncation: 'older-dropped', fresh: true,
    });
    render(<InboxDialog open onClose={() => {}} threads={facade as never} onNewReport={() => {}} />);
    fireEvent.click(await screen.findByText('Login crash'));
    expect(await screen.findByText('Earlier messages not shown.')).toBeInTheDocument();
  });

  it('shows a different notice, and does not mark read, when the hard page ceiling was hit (truncation: incomplete)', async () => {
    const facade = fakeFacade();
    (facade.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 't1', status: 'open', reportTitle: 'Login crash', messages: [], pending: [], truncation: 'incomplete', fresh: true,
    });
    render(<InboxDialog open onClose={() => {}} threads={facade as never} onNewReport={() => {}} />);
    fireEvent.click(await screen.findByText('Login crash'));
    expect(
      await screen.findByText("This conversation couldn't fully load — some messages may be missing."),
    ).toBeInTheDocument();
    expect(screen.queryByText('Earlier messages not shown.')).toBeNull();
    // Finding 2 (PR review round 2): 'incomplete' means we cannot vouch the
    // window holds the true latest messages — acking it as read would hide
    // real unseen messages.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(facade.markRead).not.toHaveBeenCalled();
  });

  // Finding 2 (PR review round 2): a failed/incomplete get() must not be
  // silently acknowledged as read. `fresh: false` marks a cached or
  // sentBuffer-only fallback returned after a transient failure — the
  // reporter never actually saw a confirmed current view on THIS render.
  it('does not mark read when the loaded detail is not fresh (a cached fallback after a transient failure)', async () => {
    const facade = fakeFacade();
    (facade.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 't1', status: 'open', reportTitle: 'Login crash', messages: [], pending: [], truncation: false, fresh: false,
    });
    render(<InboxDialog open onClose={() => {}} threads={facade as never} onNewReport={() => {}} />);
    fireEvent.click(await screen.findByText('Login crash'));
    // The view still renders normally — a stale cached view is still shown.
    await screen.findByRole('button', { name: 'Send a follow-up report' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(facade.markRead).not.toHaveBeenCalled();
  });

  it('marks read for a fresh load whose truncation is older-dropped (the latest messages ARE shown)', async () => {
    const facade = fakeFacade();
    (facade.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 't1', status: 'open', reportTitle: 'Login crash', messages: [], pending: [], truncation: 'older-dropped', fresh: true,
    });
    render(<InboxDialog open onClose={() => {}} threads={facade as never} onNewReport={() => {}} />);
    fireEvent.click(await screen.findByText('Login crash'));
    await waitFor(() => expect(facade.markRead).toHaveBeenCalledWith('t1'));
  });

  // Finding 3 (PR review round 2): a 404'd (vanished) thread previously left
  // the view on "Loading…" forever — get() resolving null just left
  // `detail` at its initial null value, indistinguishable from "still
  // loading". A COMPLETED load resolving null must navigate back instead.
  it('navigates back to the list when get() resolves null (a vanished thread), instead of hanging on Loading…', async () => {
    const facade = fakeFacade();
    (facade.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    render(<InboxDialog open onClose={() => {}} threads={facade as never} onNewReport={() => {}} />);
    fireEvent.click(await screen.findByText('Login crash'));
    // Back at the list — the thread view (and its perpetual spinner) is gone.
    await waitFor(() => expect(screen.queryByRole('button', { name: '← Your reports' })).toBeNull());
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.getByText('Login crash')).toBeInTheDocument();
  });

  it('the follow-up button calls onNewReport', async () => {
    const facade = fakeFacade();
    (facade.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 't1', status: 'open', reportTitle: 'Login crash', messages: [], pending: [], truncation: false, fresh: true,
    });
    const onNewReport = vi.fn();
    render(<InboxDialog open onClose={() => {}} threads={facade as never} onNewReport={onNewReport} />);
    fireEvent.click(await screen.findByText('Login crash'));
    fireEvent.click(await screen.findByRole('button', { name: 'Send a follow-up report' }));
    expect(onNewReport).toHaveBeenCalled();
  });

  it('a back button returns from the thread view to the list', async () => {
    const facade = fakeFacade();
    (facade.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 't1', status: 'open', reportTitle: 'Login crash', messages: [], pending: [], truncation: false, fresh: true,
    });
    render(<InboxDialog open onClose={() => {}} threads={facade as never} onNewReport={() => {}} />);
    fireEvent.click(await screen.findByText('Login crash'));
    fireEvent.click(await screen.findByRole('button', { name: '← Your reports' }));
    expect(screen.queryByRole('button', { name: '← Your reports' })).toBeNull();
    // Back at the list: both seeded threads' rows are visible again.
    expect(screen.getByText('Login crash')).toBeInTheDocument();
    expect(screen.getByText('Closed')).toBeInTheDocument();
  });

  it('calls markRead exactly once per mount after a successful load', async () => {
    const facade = fakeFacade();
    (facade.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 't1', status: 'open', reportTitle: 'Login crash', messages: [], pending: [], truncation: false, fresh: true,
    });
    render(<InboxDialog open onClose={() => {}} threads={facade as never} onNewReport={() => {}} />);
    fireEvent.click(await screen.findByText('Login crash'));
    await waitFor(() => expect(facade.markRead).toHaveBeenCalledTimes(1));
    expect(facade.markRead).toHaveBeenCalledWith('t1');
    // A settled re-render must not fire a second markRead for the same mount.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(facade.markRead).toHaveBeenCalledTimes(1);
  });
});

// Round-7 PR-review Finding 3 (MEDIUM): load()'s loadingRef guard silently
// dropped any subscription notification that arrived while a load was
// already in flight — the notifier's callback called load(), which just
// returned early with no record kept. A send-confirmation notification
// delivered mid-load was therefore lost entirely, leaving the view stuck on
// whatever the in-flight (older, pre-confirmation) load resolved to until
// some unrelated poll or notification happened to arrive later. Fixed by
// recording a "reload requested while busy" flag and running exactly one
// trailing load() once the in-flight call settles.
describe('ThreadView — Finding 3 (PR review round 7): notification during an in-flight load', () => {
  const pendingSendingDetail = {
    id: 't1',
    status: 'open' as const,
    reportTitle: 'Login crash',
    messages: [],
    pending: [
      {
        localId: 'local-1',
        threadId: 't1',
        body: 'hello',
        state: 'sending' as const,
        attempts: 0,
        createdAt: '2026-08-01T01:00:00.000Z',
      },
    ],
    truncation: false as const,
    fresh: true,
  };
  const confirmedDetail = {
    id: 't1',
    status: 'open' as const,
    reportTitle: 'Login crash',
    messages: [
      {
        id: 'm1',
        authorKind: 'reporter' as const,
        authorName: null,
        body: 'hello',
        createdAt: '2026-08-01T01:00:05.000Z',
      },
    ],
    pending: [],
    truncation: false as const,
    fresh: true,
  };

  it('coalesces a notification that arrives mid-load into exactly one trailing load, and the UI ends up on the confirmed state', async () => {
    const facade = fakeFacade();
    const first = deferred<typeof pendingSendingDetail>();
    (facade.get as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async () => confirmedDetail);
    let notify: (() => void) | null = null;
    (facade.subscribe as ReturnType<typeof vi.fn>).mockImplementation((cb: () => void) => {
      notify = cb;
      return () => {};
    });
    render(<ThreadView threads={facade as never} threadId="t1" onBack={() => {}} onNewReport={() => {}} />);
    await waitFor(() => expect(facade.get).toHaveBeenCalledTimes(1));

    // A notification (e.g. the send confirmation) arrives while the load is
    // still in flight.
    act(() => {
      notify?.();
    });

    // The in-flight load now resolves with its OLDER, pre-confirmation view.
    await act(async () => {
      first.resolve(pendingSendingDetail);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Exactly one coalesced trailing load — not zero (lost) and not one per
    // notification.
    await waitFor(() => expect(facade.get).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('hello')).toBeInTheDocument();
    expect(screen.queryByText('Sending…')).toBeNull();
  });

  it('multiple notifications during one load still produce exactly ONE trailing load', async () => {
    const facade = fakeFacade();
    const first = deferred<typeof pendingSendingDetail>();
    (facade.get as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async () => confirmedDetail);
    let notify: (() => void) | null = null;
    (facade.subscribe as ReturnType<typeof vi.fn>).mockImplementation((cb: () => void) => {
      notify = cb;
      return () => {};
    });
    render(<ThreadView threads={facade as never} threadId="t1" onBack={() => {}} onNewReport={() => {}} />);
    await waitFor(() => expect(facade.get).toHaveBeenCalledTimes(1));

    act(() => {
      notify?.();
      notify?.();
      notify?.();
    });

    await act(async () => {
      first.resolve(pendingSendingDetail);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(facade.get).toHaveBeenCalledTimes(2));
    // The trailing load itself received no further notifications — it must
    // not schedule yet another one.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(facade.get).toHaveBeenCalledTimes(2);
  });

  it('does not fire a trailing load after unmount', async () => {
    const facade = fakeFacade();
    const first = deferred<typeof pendingSendingDetail>();
    (facade.get as ReturnType<typeof vi.fn>).mockImplementationOnce(() => first.promise);
    let notify: (() => void) | null = null;
    (facade.subscribe as ReturnType<typeof vi.fn>).mockImplementation((cb: () => void) => {
      notify = cb;
      return () => {};
    });
    const { unmount } = render(
      <ThreadView threads={facade as never} threadId="t1" onBack={() => {}} onNewReport={() => {}} />,
    );
    await waitFor(() => expect(facade.get).toHaveBeenCalledTimes(1));

    act(() => {
      notify?.();
    });
    unmount();

    await act(async () => {
      first.resolve(pendingSendingDetail);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(facade.get).toHaveBeenCalledTimes(1);
  });

  it('a load with no notifications during it does not trigger an extra call', async () => {
    const facade = fakeFacade();
    (facade.get as ReturnType<typeof vi.fn>).mockResolvedValue(confirmedDetail);
    render(<ThreadView threads={facade as never} threadId="t1" onBack={() => {}} onNewReport={() => {}} />);
    await waitFor(() => expect(facade.get).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(facade.get).toHaveBeenCalledTimes(1);
  });
});
