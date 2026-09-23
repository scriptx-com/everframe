// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { useState, type JSX } from 'react';
import type { EverframeClient } from '@everframe/sdk-core';
import { Modal } from '../primitives/Modal.js';
import { ThreadListView } from './ThreadListView.js';
import { ThreadView } from './ThreadView.js';

export interface InboxDialogProps {
  open: boolean;
  onClose: () => void;
  /** The public `tx.threads.*` facade (spec 2026-07-31) — nothing else. */
  threads: EverframeClient['threads'];
  /** Opens the normal capture flow (wired by the host Provider). */
  onNewReport: () => void;
}

type InboxView = { view: 'list' } | { view: 'thread'; threadId: string };

/**
 * InboxDialog — "Your reports". Owns only navigation state (`list` vs a
 * single open `thread`); all thread data flows through the `threads` facade
 * prop, never a side channel. Hosted in the shared Modal primitive.
 */
export function InboxDialog({ open, onClose, threads, onNewReport }: InboxDialogProps): JSX.Element | null {
  const [view, setView] = useState<InboxView>({ view: 'list' });

  const handleClose = (): void => {
    onClose();
    // Reset to the list so the next open never resumes mid-thread.
    setView({ view: 'list' });
  };

  return (
    <Modal open={open} onClose={handleClose} title="Your reports">
      {view.view === 'list' ? (
        <ThreadListView
          threads={threads}
          onOpenThread={(threadId) => setView({ view: 'thread', threadId })}
          onNewReport={onNewReport}
        />
      ) : (
        <ThreadView
          threads={threads}
          threadId={view.threadId}
          onBack={() => setView({ view: 'list' })}
          onNewReport={onNewReport}
        />
      )}
    </Modal>
  );
}
