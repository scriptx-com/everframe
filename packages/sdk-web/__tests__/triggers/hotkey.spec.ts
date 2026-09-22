// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { describe, expect, it, vi, afterEach } from "vitest";
import { parseBinding, registerHotkey } from "../../src/triggers/hotkey.js";

describe("parseBinding", () => {
  it("Mod resolves to meta on macOS", () => {
    expect(parseBinding("Mod+Shift+B", true)).toEqual({
      meta: true,
      ctrl: false,
      shift: true,
      alt: false,
      key: "B",
      keys: ["B"],
    });
  });
  it("Mod resolves to ctrl off macOS", () => {
    expect(parseBinding("Mod+Shift+B", false)).toEqual({
      meta: false,
      ctrl: true,
      shift: true,
      alt: false,
      key: "B",
      keys: ["B"],
    });
  });
  it("parses combinations of modifier tokens", () => {
    expect(parseBinding("Ctrl+Alt+Shift+K", false)).toEqual({
      meta: false,
      ctrl: true,
      shift: true,
      alt: true,
      key: "K",
      keys: ["K"],
    });
  });

  it("keeps every non-modifier key in a chord", () => {
    expect(parseBinding("Shift+A+S+D", false)).toEqual({
      meta: false,
      ctrl: false,
      shift: true,
      alt: false,
      key: "D",
      keys: ["A", "S", "D"],
    });
  });
});

describe("registerHotkey", () => {
  let unregister: () => void = () => undefined;
  afterEach(() => {
    unregister();
    unregister = () => undefined;
    if (document.body.firstChild) {
      while (document.body.firstChild)
        document.body.removeChild(document.body.firstChild);
    }
  });

  it("triggers handler on Cmd+Shift+B (macOS) when nothing focused", () => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    const h = vi.fn();
    unregister = registerHotkey(h);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "B", metaKey: true, shiftKey: true }),
    );
    expect(h).toHaveBeenCalledTimes(1);
  });

  it("does NOT trigger when an <input> is focused (default)", () => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    const h = vi.fn();
    const inp = document.createElement("input");
    document.body.appendChild(inp);
    inp.focus();
    unregister = registerHotkey(h);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "B", metaKey: true, shiftKey: true }),
    );
    expect(h).not.toHaveBeenCalled();
  });

  it("triggers inside <input> when captureWhileTyping=true", () => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    const h = vi.fn();
    const inp = document.createElement("input");
    document.body.appendChild(inp);
    inp.focus();
    unregister = registerHotkey(h, { captureWhileTyping: true });
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "B", metaKey: true, shiftKey: true }),
    );
    expect(h).toHaveBeenCalledTimes(1);
  });

  it("config=false registers nothing", () => {
    const h = vi.fn();
    unregister = registerHotkey(h, false);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "B", metaKey: true, shiftKey: true }),
    );
    expect(h).not.toHaveBeenCalled();
  });

  it("multiple bindings — any match triggers", () => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    const h = vi.fn();
    unregister = registerHotkey(h, { binding: ["Mod+Shift+B", "Alt+Q"] });
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Q", altKey: true }),
    );
    expect(h).toHaveBeenCalledTimes(1);
  });

  it("triggers when multiple ordinary keys are held together", () => {
    const h = vi.fn();
    unregister = registerHotkey(h, { binding: "Shift+A+S+D" });

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Shift", shiftKey: true }),
    );
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "D", shiftKey: true }),
    );
    expect(h).not.toHaveBeenCalled();
    window.dispatchEvent(
      new KeyboardEvent("keyup", { key: "D", shiftKey: true }),
    );

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "A", shiftKey: true }),
    );
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "S", shiftKey: true }),
    );
    expect(h).not.toHaveBeenCalled();

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "D", shiftKey: true }),
    );
    expect(h).toHaveBeenCalledTimes(1);
  });

  it("matches physical letter keys when Option changes their characters", () => {
    const h = vi.fn();
    unregister = registerHotkey(h, { binding: "Alt+A+S" });

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Alt",
        code: "AltLeft",
        altKey: true,
      }),
    );
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "å",
        code: "KeyA",
        altKey: true,
      }),
    );
    expect(h).not.toHaveBeenCalled();

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ß",
        code: "KeyS",
        altKey: true,
      }),
    );
    expect(h).toHaveBeenCalledTimes(1);
  });
});
