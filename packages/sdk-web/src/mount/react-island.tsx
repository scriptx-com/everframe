// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The lazy React boundary. Reached ONLY through a dynamic import in init.ts,
// so react, react-dom and the whole dialog tree land in a separate chunk that
// is not fetched until someone opens the reporter. This is the ONLY module in
// the package that imports React outside `reporter-ui/`.
//
// What it renders is the vanilla counterpart of provider.tsx's render body:
// the reporter dialog, the replies inbox and the outcome toast. The FAB is
// NOT here — it is the ambient footprint and is plain DOM (mount/ambient.ts),
// which is the entire reason React can stay out of the always-loaded entry.
// CompanionPinCard / CompanionBadge are still React-path-only.
//
// RULING 11 — the dialog is imported by the RELATIVE path '../ui.js', never by
// the package subpath '@traceitx/web/ui'. The two look interchangeable and are
// not:
//
//   '../ui.js'            keeps this module in the SAME esbuild build graph as
//                         src/index.ts, so `splitting: true` hoists the adapter
//                         and every module-level singleton (portal target,
//                         theme host, inline theme, companion host seam,
//                         sensitive registry) into a chunk SHARED by the eager
//                         entry and this island. One instance of each.
//
//   '@traceitx/web/ui'    resolves to the SEPARATELY built dist/ui.js, which
//                         shares no chunk with dist/index.js. A vanilla host
//                         would get TWO copies of every seam: init() writes the
//                         portal target and the theme host on copy A, the
//                         dialog reads copy B, and the reporter opens into
//                         nowhere and captures nothing.
//
// Ruling 15 (init.ts must never STATICALLY import ./ui.js) and this rule are
// the same rule seen from either side of the dynamic-import boundary: static
// imports in the eager graph must avoid ui.js; the lazily-imported island must
// reach it relatively. Both exist to keep exactly one instance of everything.
import { createRoot, type Root } from 'react-dom/client';
import { useEffect, useState, type JSX } from 'react';
import {
  ReporterDialog,
  InboxDialog,
  Toast,
  type ReporterCompletePayload,
  type ToastTone,
} from '../ui.js';
import type { WebPlatformAdapter } from '../adapter.js';
import type { TraceItXClient } from '@traceitx/sdk-core';

export interface Island {
  /** Show/hide the reporter dialog. */
  setOpen(v: boolean): void;
  /** Show/hide the replies inbox — what the ambient FAB opens. */
  setInboxOpen(v: boolean): void;
  /** Raise the single outcome toast. */
  toast(tone: ToastTone, message: string): void;
  unmount(): void;
}

export interface IslandHandlers {
  /** The public `tx.threads.*` facade the inbox reads — never a side channel. */
  threads: TraceItXClient['threads'];
  onComplete(payload: ReporterCompletePayload): void;
  onCancel(): void;
  /**
   * "New report" from inside the inbox. Routed back to init.ts's `openModal()`
   * rather than handled locally, because that is where REPLAY-02's
   * freeze-before-any-UI-mounts lives — exactly as provider.tsx's InboxDialog
   * calls `ctxValue.openModal()` instead of `setModalOpen(true)`.
   */
  onNewReport(): void;
}

/**
 * Commands queued until the root commits. `createRoot().render()` is async and
 * the FIRST command always races that commit — the dynamic import that
 * produced this module was started BY the open (or FAB click) issuing it. A
 * dropped first command means the reporter or the inbox silently never
 * appears, on the only path a vanilla host takes.
 */
type IslandCommand =
  | { kind: 'open'; value: boolean }
  | { kind: 'inbox'; value: boolean }
  | { kind: 'toast'; tone: ToastTone; message: string };

export function mountIsland(
  mountTarget: ShadowRoot | HTMLElement,
  adapter: WebPlatformAdapter,
  handlers: IslandHandlers,
): Island {
  const container = document.createElement('div');
  mountTarget.appendChild(container);
  const root: Root = createRoot(container);

  let dispatch: ((c: IslandCommand) => void) | null = null;
  const pending: IslandCommand[] = [];
  const send = (c: IslandCommand): void => {
    if (dispatch) dispatch(c);
    else pending.push(c);
  };

  function Island(): JSX.Element {
    const [open, setOpen] = useState(false);
    const [inboxOpen, setInboxOpen] = useState(false);
    const [toast, setToast] = useState<{ open: boolean; tone: ToastTone; message: string }>({
      open: false,
      tone: 'success',
      message: '',
    });

    useEffect(() => {
      const apply = (c: IslandCommand): void => {
        if (c.kind === 'open') setOpen(c.value);
        else if (c.kind === 'inbox') setInboxOpen(c.value);
        else setToast({ open: true, tone: c.tone, message: c.message });
      };
      dispatch = apply;
      while (pending.length) apply(pending.shift() as IslandCommand);
      return () => {
        dispatch = null;
      };
    }, []);

    return (
      <>
        <ReporterDialog
          open={open}
          adapter={adapter}
          onComplete={(payload) => {
            setOpen(false);
            handlers.onComplete(payload);
          }}
          onCancel={() => {
            setOpen(false);
            handlers.onCancel();
          }}
        />
        <InboxDialog
          open={inboxOpen}
          onClose={() => setInboxOpen(false)}
          threads={handlers.threads}
          onNewReport={() => {
            setInboxOpen(false);
            handlers.onNewReport();
          }}
        />
        <Toast
          open={toast.open}
          tone={toast.tone}
          message={toast.message}
          onDismiss={() => setToast((prev) => ({ ...prev, open: false }))}
        />
      </>
    );
  }

  root.render(<Island />);

  return {
    setOpen: (v: boolean) => send({ kind: 'open', value: v }),
    setInboxOpen: (v: boolean) => send({ kind: 'inbox', value: v }),
    toast: (tone: ToastTone, message: string) => send({ kind: 'toast', tone, message }),
    unmount: () => {
      root.unmount();
      container.remove();
    },
  };
}
