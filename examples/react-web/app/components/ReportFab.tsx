// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// ReportFab — the HOST-owned floating "report a bug" trigger, pinned to the
// bottom-right corner of every page. The SDK deliberately ships no visible
// trigger chrome (removed in "drop built-in bubble trigger"); hosts wire
// their own button and call useEverframe().open(). This is that button, and
// it carries data-testid="everframe-bubble" — the id the e2e suite clicks.
//
// Styling lives in ReportFab.module.css (NOT inline styles / globals.css):
// the /strict-csp route group also mounts this component, and its CSP
// (style-src 'self' 'nonce-…') blocks style attributes. A CSS module is
// served as a plain stylesheet from 'self' in production builds, so the
// button stays styled even under the strict fixture.
"use client";
import { useRef, useState } from "react";
import { useEverframe } from "@everframe/react";
import styles from "./ReportFab.module.css";

export function ReportFab() {
  const { open } = useEverframe();
  const [opening, setOpening] = useState(false);
  // open() resolves when the reporter closes; the ref guards the re-render
  // gap so a double-click can't stack two dialogs.
  const busy = useRef(false);

  const onClick = async () => {
    if (busy.current) return;
    busy.current = true;
    setOpening(true);
    try {
      await open();
    } finally {
      busy.current = false;
      setOpening(false);
    }
  };

  return (
    <button
      type="button"
      className={styles.fab}
      data-testid="everframe-bubble"
      aria-label="Report a bug"
      title="Report a bug (Cmd/Ctrl+Shift+B)"
      onClick={onClick}
      disabled={opening}
    >
      <svg
        className={styles.icon}
        viewBox="0 0 24 24"
        width="20"
        height="20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        aria-hidden="true"
      >
        {/* minimal beetle glyph: body, seam, legs, antennae */}
        <ellipse cx="12" cy="13.5" rx="5" ry="6.5" />
        <path d="M12 7v13" />
        <path d="M7 11H4M7 15H4.5M17 11h3M17 15h2.5" />
        <path d="M10 7 8 4M14 7l2-3" />
      </svg>
      <span className={styles.label}>Report a bug</span>
    </button>
  );
}
