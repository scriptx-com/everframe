// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';

import { captureException } from '@traceitx/react';

function captureSourceMapCheck() {
  try {
    throw new Error('source-map-check');
  } catch (error) {
    captureException(error);
  }
}

// Each cause is constructed on its own line so its stack points at a
// distinct original position: the dashboard's "Caused by" card should map
// these two frames separately from the outer throw above.
function rootCause() {
  return new RangeError('source-map-check root cause');
}
function middleCause() {
  return new TypeError('source-map-check middle cause', { cause: rootCause() });
}
function captureSourceMapCheckWithCauses() {
  try {
    throw new Error('source-map-check with causes', { cause: middleCause() });
  } catch (error) {
    captureException(error);
  }
}

export default function SourceMapCheckPage() {
  return (
    <main className="shell">
      <p className="eyebrow">SDK surface</p>
      <h1 className="display">Error test</h1>
      <p className="lede">Trigger an error to check capture and source maps in TraceItX.</p>
      <section className="card">
        <h2 className="section-title">Send a handled error</h2>
        <p className="muted">
          This button throws and catches an error, then sends it through the SDK.
          Open this app’s errors in the dashboard and look for <code>source-map-check</code>.
        </p>
        <button className="btn btn-primary" onClick={captureSourceMapCheck}>Capture source-map-check</button>
        <button className="btn" onClick={captureSourceMapCheckWithCauses}>Capture source-map-check with causes</button>
        <p className="fixture-note">
          Build: <code>{process.env.NEXT_PUBLIC_TRACEITX_APP_BUILD || 'development (no build ID)'}</code>
        </p>
        <p className="muted">
          With source maps uploaded for this build, the stack should point to
          this page’s original throw statement. Use the production error-test
          build to verify mapping from minified JavaScript.
        </p>
      </section>
    </main>
  );
}
