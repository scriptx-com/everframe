// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import type { JSX } from 'react';
import { Modal } from './primitives/Modal.js';
import { Button } from './primitives/Button.js';

export interface DiscardConfirmModalProps {
  open: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}

/**
 * Discard-draft confirm — UI-SPEC §"Discard-draft confirm modal" lock. Default-focuses
 * "Keep editing" (autoFocus on the dismiss button mirrors Phase 02.1 admin's destructive-
 * confirm discipline — the safer action is the default). Confirm uses outline-destructive
 * variant; dismiss uses secondary.
 */
export function DiscardConfirmModal({
  open,
  onConfirm,
  onDismiss,
}: DiscardConfirmModalProps): JSX.Element {
  return (
    <Modal
      open={open}
      onClose={onDismiss}
      title="Discard this report?"
      compact
      footer={
        <>
          <Button
            variant="secondary"
            onClick={onDismiss}
            data-testid="discard-keep"
            autoFocus
          >
            Keep editing
          </Button>
          <Button
            variant="outline-destructive"
            onClick={onConfirm}
            data-testid="discard-confirm"
          >
            Discard report
          </Button>
        </>
      }
    >
      <p>Your title, description, and annotations will be lost.</p>
    </Modal>
  );
}
