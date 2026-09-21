// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
"use client";

export interface HotkeyConfig {
  binding?: string | string[] | false;
  captureWhileTyping?: boolean;
}

export interface ParsedBinding {
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** Last non-modifier key, retained for backwards compatibility. */
  key: string;
  /** Every uppercased non-modifier key in the chord. */
  keys: string[];
}

/**
 * Detect macOS for `Mod` token resolution. Reads navigator.platform first (more reliable
 * historically); falls back to userAgent regex (Mod-on-iPad maps to meta which matches
 * Cmd-Shift-B mental model in cross-platform host apps).
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac/.test(navigator.platform) || /Mac/.test(navigator.userAgent);
}

/**
 * Parse a hotkey binding string into discrete modifier flags + key. Tokens: Mod | Cmd |
 * Ctrl | Alt | Shift | Meta | keys. `Mod` resolves to Cmd on macOS, Ctrl elsewhere
 * (CONTEXT lean — in-house parser, no tinykeys dep on the SDK hot-path bundle).
 */
export function parseBinding(
  s: string,
  isMac: boolean = isMacPlatform(),
): ParsedBinding {
  const tokens = s.split("+").map((t) => t.trim());
  const out: ParsedBinding = {
    meta: false,
    ctrl: false,
    shift: false,
    alt: false,
    key: "",
    keys: [],
  };
  for (const t of tokens) {
    const u = t.toLowerCase();
    if (u === "mod") {
      if (isMac) out.meta = true;
      else out.ctrl = true;
    } else if (u === "cmd" || u === "meta") out.meta = true;
    else if (u === "ctrl") out.ctrl = true;
    else if (u === "shift") out.shift = true;
    else if (u === "alt") out.alt = true;
    else if (t.length > 0) {
      out.key = t.toUpperCase();
      out.keys.push(out.key);
    }
  }
  return out;
}

function normalizedEventKey(
  event: Pick<KeyboardEvent, "code" | "key">,
): string {
  if (event.key === "Meta") return "META";
  if (event.key === "Control") return "CONTROL";
  if (event.key === "Shift") return "SHIFT";
  if (event.key === "Alt") return "ALT";
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  return event.key.toUpperCase();
}

function bindingKeys(binding: ParsedBinding): Set<string> {
  const keys = new Set(binding.keys);
  if (binding.meta) keys.add("META");
  if (binding.ctrl) keys.add("CONTROL");
  if (binding.shift) keys.add("SHIFT");
  if (binding.alt) keys.add("ALT");
  return keys;
}

function matches(pressedKeys: Set<string>, binding: Set<string>): boolean {
  if (pressedKeys.size !== binding.size) return false;
  return [...binding].every((key) => pressedKeys.has(key));
}

function matchesSingleKeyEvent(
  event: KeyboardEvent,
  binding: ParsedBinding,
): boolean {
  if (binding.keys.length !== 1) return false;
  if (event.metaKey !== binding.meta) return false;
  if (event.ctrlKey !== binding.ctrl) return false;
  if (event.shiftKey !== binding.shift) return false;
  if (event.altKey !== binding.alt) return false;
  return normalizedEventKey(event) === binding.keys[0];
}

function isInputFocus(): boolean {
  if (typeof document === "undefined") return false;
  const a = document.activeElement;
  if (!a) return false;
  const tag = a.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if ((a as HTMLElement).isContentEditable) return true;
  return false;
}

/**
 * Register a window keydown listener for the configured binding. `false` short-circuits to
 * a no-op unregister (TRIG-03 hide path). When the user is typing in an input/textarea,
 * the hotkey is suppressed by default — opt back in with `captureWhileTyping: true`.
 */
export function registerHotkey(
  handler: () => void,
  config?: HotkeyConfig | false,
): () => void {
  const noop = (): void => undefined;
  if (config === false) return noop;
  const binding = config?.binding;
  if (binding === false) return noop;
  if (typeof window === "undefined") return noop;
  const raw = binding ?? "Mod+Shift+B";
  const bindings = (Array.isArray(raw) ? raw : [raw]).map((s) =>
    parseBinding(s),
  );
  const keySets = bindings.map(bindingKeys);
  const pressedKeys = new Set<string>();
  const captureWhileTyping = config?.captureWhileTyping === true;
  const onKey = (e: KeyboardEvent): void => {
    if (!captureWhileTyping && isInputFocus()) return;
    if (e.metaKey) pressedKeys.add("META");
    if (e.ctrlKey) pressedKeys.add("CONTROL");
    if (e.shiftKey) pressedKeys.add("SHIFT");
    if (e.altKey) pressedKeys.add("ALT");
    pressedKeys.add(normalizedEventKey(e));
    const matched = bindings.some((parsed, index) =>
      parsed.keys.length === 1
        ? matchesSingleKeyEvent(e, parsed)
        : matches(pressedKeys, keySets[index]!),
    );
    if (!e.repeat && matched) {
      e.preventDefault();
      try {
        handler();
      } catch {
        /* swallow — DEFE-02 */
      }
    }
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    pressedKeys.delete(normalizedEventKey(e));
  };
  const onBlur = (): void => pressedKeys.clear();
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  return () => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
  };
}

/** @internal Cross-package bridge for the React provider. */
export function __registerDashboardHotkey(
  handler: () => void,
  binding: string,
): () => void {
  return registerHotkey(handler, { binding });
}
