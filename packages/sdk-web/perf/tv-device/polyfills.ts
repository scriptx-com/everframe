// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Device-harness-only prelude for Chrome 53 (webOS 4) / Chrome 79 (webOS 6).
// A consumer's bundler normally supplies these; the harness bundles its own.
/* eslint-disable @typescript-eslint/no-explicit-any */
const g: any = typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : window;
if (typeof (g as any).globalThis === 'undefined') (g as any).globalThis = g;
if (!Object.entries) (Object as any).entries = (o: any) => Object.keys(o).map((k) => [k, o[k]]);
if (!Object.values) (Object as any).values = (o: any) => Object.keys(o).map((k) => o[k]);
if (!(Object as any).fromEntries) (Object as any).fromEntries = (it: any) => { const o: any = {}; for (const [k, v] of it) o[k] = v; return o; };
if (!(Array.prototype as any).flat) (Array.prototype as any).flat = function (this: any[], d = 1): any[] { return d < 1 ? this.slice() : this.reduce((a: any[], v) => a.concat(Array.isArray(v) ? (v as any).flat(d - 1) : v), []); };
if (!(Array.prototype as any).flatMap) (Array.prototype as any).flatMap = function (this: any[], f: any) { return (this.map(f) as any).flat(1); };
if (!(String.prototype as any).padStart) (String.prototype as any).padStart = function (this: string, n: number, s = ' ') { let r = String(this); while (r.length < n) r = s + r; return r.slice(-Math.max(n, this.length)); };
if (!(Promise.prototype as any).finally) (Promise.prototype as any).finally = function (this: Promise<any>, f: () => void) { return this.then((v) => { f(); return v; }, (e) => { f(); throw e; }); };
if (!(Element.prototype as any).append) (Element.prototype as any).append = function (this: Element, ...nodes: any[]) { for (const n of nodes) this.appendChild(typeof n === 'string' ? document.createTextNode(n) : n); };
if (!(Node.prototype as any).getRootNode) (Node.prototype as any).getRootNode = function (this: Node) { let n: Node = this; while (n.parentNode) n = n.parentNode; return n; };
if (typeof (g as any).queueMicrotask !== 'function') (g as any).queueMicrotask = (f: () => void) => Promise.resolve().then(f);

