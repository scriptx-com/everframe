// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { MESSAGE_BODY_MAX } from '@everframe/sdk-core';
import type { EverframeClient, ThreadDetail, ThreadClientState } from '@everframe/sdk-core';
import { Modal } from '../primitives/Modal.js';
import { Button } from '../primitives/Button.js';
import { Textarea } from '../primitives/Textarea.js';

export interface ThreadViewProps {
  threads: EverframeClient['threads'];
  threadId: string;
  onBack: () => void;
  /** Opens the normal capture flow (wired by the host Provider). */
  onNewReport: () => void;
}

/**
 * Thread detail — messages, composer, optimistic send states. Reads and
 * writes exclusively through the public `tx.threads.*` facade prop (spec
 * 2026-07-31); no side channel to any transport internals.
 *
 * Message bodies render as JSX text ({m.body}) — React's default escaping
 * IS the sanitizer. No HTML injection point exists here, and none may be
 * added (a raw-HTML render is a security regression, not a feature).
 *
 * Known deviation: "Send a follow-up report" opens the normal capture flow
 * via `onNewReport` with no auto-link back to this thread — the host
 * Provider owns capture → submit, and threading a draft-time link through
 * that flow is out of scope here. Documented, not attempted.
 *
 * The Modal primitive has no header slot, so the "back to list" affordance
 * lives at the top of this view's own body instead.
 */
export function ThreadView({ threads, threadId, onBack, onNewReport }: ThreadViewProps): JSX.Element {
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [clientState, setClientState] = useState<ThreadClientState>(() => threads.getState());
  const [body, setBody] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Non-fatal: a failed delete leaves the thread in place (the facade
  // resolves false rather than throwing), so surface a retry hint here
  // instead of navigating away as if it had succeeded.
  const [deleteFailed, setDeleteFailed] = useState(false);

  // Guards load() against overlap (a subscription ping racing the initial
  // load, or two pings racing each other) and markRead() against firing
  // more than once per successful load.
  const loadingRef = useRef(false);
  // Round-7 PR-review Finding 3 (MEDIUM): a notification (subscribe ping)
  // that arrived while a load was already in flight used to be dropped
  // outright by the `loadingRef` guard below — the pinging call() returned
  // early with nothing recorded, so a send-confirmation notification
  // delivered mid-load was lost, and the view sat on the in-flight load's
  // (older, pre-confirmation) result until an unrelated poll or
  // notification happened to arrive. Instead, record that a reload was
  // requested while busy and run exactly ONE trailing load() once the
  // in-flight call settles — coalescing any number of notifications that
  // land during a single load into one refresh, not a queue of them.
  const reloadPendingRef = useRef(false);
  // Guards the trailing load scheduled above from firing after unmount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const markedReadRef = useRef(false);
  // Ref (not a dependency) so load()'s identity — and thus the subscribe
  // effect below — doesn't churn every time the parent re-renders with a
  // fresh onBack closure (InboxDialog creates one inline per render).
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);

  const load = useCallback(async () => {
    if (loadingRef.current) {
      // A load is already in flight — record that another was requested
      // instead of dropping it. Idempotent: any number of notifications
      // landing before the in-flight call settles still yields exactly one
      // trailing load below, not one per notification.
      reloadPendingRef.current = true;
      return;
    }
    loadingRef.current = true;
    // Set when this call navigates away (a vanished thread) — a trailing
    // load shouldn't fire against a thread we're leaving.
    let navigatedAway = false;
    try {
      const result = await threads.get(threadId);
      // Finding 3 (PR review round 2): a vanished (404'd) or otherwise
      // unreachable thread previously left `detail` at its initial `null`
      // forever — indistinguishable from "still loading" — so the view got
      // stuck on the spinner. A COMPLETED load resolving null means there's
      // nothing left to show here; leave the thread view instead of hanging.
      if (result === null) {
        navigatedAway = true;
        onBackRef.current();
        return;
      }
      setDetail(result);
      // Finding 2 (PR review round 2): only acknowledge messages the
      // reporter actually saw. `fresh` is false for a cached/fallback
      // return after a transient failure — acking that would clear the
      // server unread cursor for messages never displayed. `truncation ===
      // 'incomplete'` means the hard page ceiling was hit before the server
      // confirmed hasMore:false, so we can't vouch the window holds the
      // true latest messages either (mirrors the admin panel's same rule —
      // the dashboard thread UI).
      if (!markedReadRef.current && result.fresh && result.truncation !== 'incomplete') {
        markedReadRef.current = true;
        void threads.markRead(threadId);
      }
    } finally {
      loadingRef.current = false;
      const shouldReload = reloadPendingRef.current && mountedRef.current && !navigatedAway;
      reloadPendingRef.current = false;
      if (shouldReload) {
        // Exactly one trailing load. If IT receives no further notification
        // while running, `reloadPendingRef` stays false through its own
        // finally and nothing schedules again — no loop.
        void load();
      }
    }
  }, [threads, threadId]);

  useEffect(() => {
    markedReadRef.current = false;
    setDetail(null);
    setDeleteFailed(false);
    void load();
  }, [load]);

  useEffect(
    () =>
      threads.subscribe(() => {
        setClientState(threads.getState());
        void load();
      }),
    [threads, threadId, load],
  );

  // Round-6 PR-review Finding 4 (MEDIUM) — `cooldownActive` below is derived
  // from `Date.now()` purely at render time. A 429 from `get()` can set the
  // global cooldown deadline with no pending send in flight, and later
  // ETag-304 polls don't notify subscribers — so crossing the deadline
  // changes no React state and the composer/Send stay disabled until an
  // unrelated notification or a close/reopen. Schedule a one-shot timeout
  // for the remaining cooldown that forces a re-render exactly when it
  // expires; cancelled and rescheduled whenever the deadline itself changes,
  // and cleaned up on unmount. Mirrors the admin composer's local countdown
  // (the dashboard thread UI) in
  // spirit — a load-bearing self-re-enable — without needing a per-second
  // tick here since no visible countdown copy is shown.
  const [, forceCooldownRerender] = useState(0);
  useEffect(() => {
    const deadline = clientState.cooldownUntilMs;
    if (deadline === null) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    const id = setTimeout(() => forceCooldownRerender((n) => n + 1), remaining);
    return () => clearTimeout(id);
  }, [clientState.cooldownUntilMs]);

  const handleSend = (): void => {
    const text = body;
    if (text.trim().length === 0) return;
    setBody('');
    void threads.reply(threadId, text);
  };

  const handleDelete = async (): Promise<void> => {
    setConfirmingDelete(false);
    const deleted = await threads.delete(threadId);
    if (deleted) {
      onBack();
    } else {
      setDeleteFailed(true);
    }
  };

  const cooldownActive =
    clientState.cooldownUntilMs !== null && clientState.cooldownUntilMs > Date.now();
  const closed = detail?.status === 'closed';
  // Finding 3 (round 10, PR review): sdk-core's retryMessage() now no-ops
  // (no POST) on a read-only client or a locally-closed thread, but the
  // built-in UI still rendered Retry independent of either — a click
  // still called into the facade regardless. Neither write path should be
  // offered here: readOnly (the replies_disabled latch) or a thread this
  // view itself already renders as closed.
  const retryUnavailable = clientState.readOnly || closed;
  const trimmedEmpty = body.trim().length === 0;

  return (
    <div className="everframe-inbox-thread">
      <button type="button" className="everframe-inbox-back" onClick={onBack}>
        ← Your reports
      </button>

      {detail ? (
        <>
          {detail.truncation === 'older-dropped' ? (
            <p className="everframe-inbox-truncated-notice">Earlier messages not shown.</p>
          ) : null}
          {detail.truncation === 'incomplete' ? (
            <p className="everframe-inbox-truncated-notice">
              This conversation couldn't fully load — some messages may be missing.
            </p>
          ) : null}
          <div className="everframe-inbox-msgs">
            {detail.messages.map((m) => (
              <div
                key={m.id}
                className={`everframe-inbox-msg ${m.authorKind === 'reporter' ? 'everframe-inbox-msg-mine' : 'everframe-inbox-msg-theirs'}`}
              >
                {m.authorKind !== 'reporter' ? (
                  <span className="everframe-inbox-msg-author">{m.authorName ?? 'Support'}</span>
                ) : null}
                <p className="everframe-inbox-msg-body">{m.body}</p>
                <span className="everframe-inbox-msg-time">{new Date(m.createdAt).toLocaleString()}</span>
              </div>
            ))}
            {detail.pending.map((p) => (
              <div key={p.localId} className="everframe-inbox-msg everframe-inbox-msg-mine everframe-inbox-pending">
                <p className="everframe-inbox-msg-body">{p.body}</p>
                {p.state === 'sending' ? (
                  <span className="everframe-inbox-msg-time">Sending…</span>
                ) : retryUnavailable ? (
                  // Finding 3 (round 10, PR review): a read-only client or a
                  // closed thread must not offer Retry at all — every
                  // future attempt would 401/409 again, and sdk-core's
                  // retryMessage() itself now no-ops here too (belt and
                  // braces). The failed bubble and its text stay visible so
                  // nothing typed is lost; there's just nothing left to
                  // click.
                  <span className="everframe-inbox-msg-time">Not sent.</span>
                ) : (
                  <span className="everframe-inbox-msg-time">
                    Not sent.{' '}
                    <Button
                      variant="secondary"
                      size="sm"
                      // Finding 2 (round 9, PR review): sdk-core's
                      // retryMessage() now defers the actual POST while the
                      // send cooldown is active rather than firing straight
                      // into it, but leaving Retry clickable here was still
                      // confusing — the composer right below visibly
                      // disables itself for the same reason. Reuse the same
                      // `cooldownActive` derived state (and its timer, above)
                      // so Retry re-enables itself the moment the deadline
                      // passes, with no extra subscription needed.
                      disabled={cooldownActive}
                      onClick={() => void threads.retryMessage(p.localId)}
                    >
                      Retry
                    </Button>
                  </span>
                )}
              </div>
            ))}
          </div>

          {closed ? (
            <p className="everframe-inbox-closed-notice">This conversation is closed.</p>
          ) : (
            <div className="everframe-inbox-composer">
              <Textarea
                aria-label="Reply"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={MESSAGE_BODY_MAX}
                disabled={cooldownActive}
                placeholder="Write a reply…"
              />
              {cooldownActive ? (
                <p className="everframe-inbox-cooldown">
                  You're sending too fast — try again in a moment.
                </p>
              ) : null}
              <Button variant="primary" onClick={handleSend} disabled={trimmedEmpty || cooldownActive}>
                Send
              </Button>
            </div>
          )}

          {deleteFailed ? (
            <p className="everframe-inbox-delete-error">Couldn't delete — try again.</p>
          ) : null}

          <div className="everframe-inbox-thread-actions">
            <Button variant="secondary" onClick={onNewReport}>
              Send a follow-up report
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setDeleteFailed(false);
                setConfirmingDelete(true);
              }}
            >
              Delete this conversation
            </Button>
          </div>
        </>
      ) : (
        <div className="everframe-inbox-loading">Loading…</div>
      )}

      <Modal
        open={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        title="Delete this conversation?"
        compact
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmingDelete(false)} autoFocus>
              Keep it
            </Button>
            <Button variant="outline-destructive" onClick={() => void handleDelete()}>
              Delete conversation
            </Button>
          </>
        }
      >
        <p>Deletes this conversation for you. The report you sent is not deleted.</p>
      </Modal>
    </div>
  );
}
