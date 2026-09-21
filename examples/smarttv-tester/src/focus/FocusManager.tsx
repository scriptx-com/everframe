// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Simple TV focus manager: one provider owning a registry of focusable
// elements plus a window keydown listener; `useFocusable` registers an
// element and reports whether it currently holds focus. Arrow keys move
// focus geometrically (see spatial.ts), Enter/OK selects, and the remote
// back keys (Tizen 10009, webOS 461, Escape on desktop) bubble to `onBack`.
//
// Deliberately minimal — no focus scopes, no portals, no per-section trees.
// For a real product app reach for a full spatial-navigation library; this
// exists so the tester can exercise remote input on its own.
import * as React from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { pickNextFocus, type Direction } from './spatial.js';

interface Entry {
  el: HTMLElement;
  onSelect: React.RefObject<(() => void) | undefined>;
}

interface FocusApi {
  focusedId: string | null;
  register: (id: string, entry: Entry, autoFocus: boolean) => void;
  unregister: (id: string) => void;
  requestFocus: (id: string) => void;
}

const FocusContext = createContext<FocusApi | null>(null);

const KEY_TO_DIRECTION: Record<number, Direction> = {
  37: 'left',
  38: 'up',
  39: 'right',
  40: 'down',
};

const KEY_ENTER = 13;
// Remote "back": Samsung Tizen sends 10009, LG webOS sends 461; Escape
// stands in on a desktop keyboard.
const BACK_KEYS = new Set([10009, 461, 27]);

export function FocusProvider({
  children,
  onBack,
}: {
  children: React.ReactNode;
  onBack?: () => void;
}): React.JSX.Element {
  const entries = useRef(new Map<string, Entry>());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // Refs mirror state/props so the single keydown listener never goes stale.
  const focusedRef = useRef<string | null>(null);
  focusedRef.current = focusedId;
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  // When an auto-focused element (e.g. a modal's close button) unmounts,
  // focus returns to whatever held it before the modal opened.
  const restoreStack = useRef<Array<{ owner: string; previous: string | null }>>([]);

  const firstEntryId = () => {
    const first = entries.current.keys().next();
    return first.done ? null : first.value;
  };

  const register = useCallback((id: string, entry: Entry, autoFocus: boolean) => {
    entries.current.set(id, entry);
    if (autoFocus) {
      restoreStack.current.push({ owner: id, previous: focusedRef.current });
      setFocusedId(id);
    } else {
      // First focusable to mount takes initial focus.
      setFocusedId((cur) => cur ?? id);
    }
  }, []);

  const unregister = useCallback((id: string) => {
    entries.current.delete(id);
    const restoreIdx = restoreStack.current.findIndex((r) => r.owner === id);
    const restore = restoreIdx >= 0 ? restoreStack.current.splice(restoreIdx, 1)[0] : null;
    setFocusedId((cur) => {
      if (cur !== id) return cur;
      if (restore?.previous && entries.current.has(restore.previous)) return restore.previous;
      return firstEntryId();
    });
  }, []);

  const requestFocus = useCallback((id: string) => {
    if (entries.current.has(id)) setFocusedId(id);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const direction = KEY_TO_DIRECTION[e.keyCode];

      if (direction) {
        const currentId = focusedRef.current;
        const current = currentId ? entries.current.get(currentId) : undefined;
        if (!current) {
          const first = firstEntryId();
          if (first) setFocusedId(first);
          e.preventDefault();
          return;
        }
        const candidates = [...entries.current.entries()]
          .filter(([id]) => id !== currentId)
          .map(([id, entry]) => ({ id, rect: entry.el.getBoundingClientRect() }));
        const next = pickNextFocus(current.el.getBoundingClientRect(), candidates, direction);
        if (next) {
          setFocusedId(next);
          // Old TV engines lack scrollIntoView options; plain call is the
          // lowest common denominator.
          try {
            entries.current.get(next)?.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          } catch {
            entries.current.get(next)?.el.scrollIntoView();
          }
        }
        e.preventDefault();
        return;
      }

      if (e.keyCode === KEY_ENTER) {
        const currentId = focusedRef.current;
        const entry = currentId ? entries.current.get(currentId) : undefined;
        entry?.onSelect.current?.();
        e.preventDefault();
        return;
      }

      if (BACK_KEYS.has(e.keyCode)) {
        onBackRef.current?.();
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const api = useMemo<FocusApi>(
    () => ({ focusedId, register, unregister, requestFocus }),
    [focusedId, register, unregister, requestFocus],
  );

  return <FocusContext.Provider value={api}>{children}</FocusContext.Provider>;
}

export function useFocusApi(): FocusApi {
  const api = useContext(FocusContext);
  if (!api) throw new Error('useFocusApi must be used inside <FocusProvider>');
  return api;
}

export interface UseFocusableOptions {
  /** Stable id; defaults to React's useId. Useful for requestFocus(). */
  id?: string;
  /** Invoked on Enter/OK while this element holds focus. */
  onSelect?: () => void;
  /** Steal focus on mount and give it back on unmount (modals). */
  autoFocus?: boolean;
}

export function useFocusable(options: UseFocusableOptions = {}): {
  ref: React.RefCallback<HTMLElement | null>;
  focused: boolean;
  id: string;
} {
  const { register, unregister, focusedId } = useFocusApi();
  const generatedId = useId();
  const id = options.id ?? generatedId;
  const onSelectRef = useRef(options.onSelect);
  onSelectRef.current = options.onSelect;
  const autoFocusRef = useRef(options.autoFocus ?? false);

  const elRef = useRef<HTMLElement | null>(null);
  const ref = useCallback<React.RefCallback<HTMLElement | null>>(
    (el) => {
      if (el) {
        elRef.current = el;
        register(id, { el, onSelect: onSelectRef }, autoFocusRef.current);
      } else if (elRef.current) {
        elRef.current = null;
        unregister(id);
      }
    },
    [id, register, unregister],
  );

  return { ref, focused: focusedId === id, id };
}
