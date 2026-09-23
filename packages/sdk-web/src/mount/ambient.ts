// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

/**
 * The reporter's entire ambient footprint, in plain DOM.
 *
 * This exists so React can stay out of the always-loaded bundle: the FAB is
 * the only thing on screen before someone opens the reporter, and it is 20
 * lines of DOM. Everything else is behind the lazy island. Markup, class names
 * and aria-label copy are kept identical to ReporterFab.tsx so both paths
 * share one stylesheet and one accessibility contract — change one and the
 * other has to move with it.
 *
 * IN THE ALWAYS-LOADED GRAPH: `init.ts` imports this statically, so nothing
 * here may reach `react`, `react-dom` or `lucide-react`. That is why the
 * MessageSquare glyph below is inlined as raw SVG rather than imported.
 */
export interface AmbientUI {
  setUnread(n: number): void;
  setVisible(v: boolean): void;
  destroy(): void;
}

/**
 * `lucide-react`'s `MessageSquare` path, verbatim. Inlined (rather than
 * imported) so the icon package — which is React — never reaches the eager
 * graph. The surrounding <svg> attributes reproduce lucide's own defaults
 * (24x24 viewBox, 2px round strokes, currentColor) at `size={20}`, so the
 * rendered glyph is pixel-identical to `<MessageSquare size={20} />`.
 */
const MESSAGE_SQUARE_PATH =
  'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z';

export function createAmbientUI(
  root: ShadowRoot | HTMLElement,
  opts: { onOpen(): void },
): AmbientUI {
  const wrap = document.createElement('div');
  wrap.className = 'everframe-root everframe-fab-wrap';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'everframe-fab';
  button.dataset['testid'] = 'reporter-fab';
  button.addEventListener('click', () => opts.onOpen());

  button.innerHTML =
    `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<path d="${MESSAGE_SQUARE_PATH}"/></svg>`;

  const dot = document.createElement('span');
  dot.className = 'everframe-fab-dot';
  dot.setAttribute('aria-hidden', 'true');

  wrap.appendChild(button);

  let unread = 0;
  let visible = false;

  const applyLabel = (): void => {
    button.setAttribute(
      'aria-label',
      unread > 0 ? `Your reports — ${unread} unread` : 'Your reports',
    );
  };
  applyLabel();

  return {
    setUnread(n: number) {
      unread = n;
      if (n > 0) {
        // The dot lives INSIDE the button, after the glyph — same position
        // ReporterFab renders it in, so `.everframe-fab-dot`'s absolute placement
        // resolves against the same offset parent.
        if (!dot.isConnected) button.appendChild(dot);
      } else {
        dot.remove();
      }
      applyLabel();
    },
    setVisible(v: boolean) {
      if (v === visible) return;
      visible = v;
      if (v) root.appendChild(wrap);
      else wrap.remove();
    },
    destroy() {
      wrap.remove();
    },
  };
}
