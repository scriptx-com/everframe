// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// A video endpoint that ANSWERS BUT NEVER FINISHES: it sends 200 + a
// Content-Length promising far more bytes than it delivers, writes a token
// prefix, and then holds the stream open forever.
//
// This is the shape that used to wedge the web screenshot pipeline, and it is
// deliberately hard to fake any other way. A <video> pointed here parks at
// readyState 0 (HAVE_NOTHING) indefinitely — it never fires `loadeddata` and
// it never fires `error`, because from the browser's point of view the
// response is still perfectly healthy and simply incomplete. A merely BROKEN
// url would fire `error` almost immediately and exercise a different, far
// more forgiving path.
//
// `force-dynamic` because a route handler with no request-dependent input is
// eligible for static rendering, which would resolve this at build time and
// defeat the entire point.
export const dynamic = 'force-dynamic';

export function GET(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Enough bytes to look like a real response beginning, nowhere near
      // enough to decode a frame from.
      controller.enqueue(new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]));
      // Never close() and never error() — the request hangs until the client
      // navigates away and the browser tears the connection down.
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'video/mp4',
      // A promise the body never keeps, so the browser keeps waiting for more.
      'content-length': '9999999',
      'cache-control': 'no-store',
    },
  });
}
