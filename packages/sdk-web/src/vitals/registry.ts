// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Player identity + explicit registrations (spec 2026-09-02 §2 "Registry, not
// direct wiring"). Lives at module scope in vitals/index.ts so it outlives the
// collector: vitals start asynchronously (server config), stop on kill, and
// rotate — the customer's `trackPlayer` intent must survive all three. Ids are
// held WEAKLY so auto-attached elements never leak; explicit registrations are
// strong until `detach()`/`clear()`.
import type { PlayerRegistrationLike } from './player-adapter.js';

export interface PlayerRegistry {
  idFor(el: HTMLMediaElement): string;
  register(r: PlayerRegistrationLike): string;
  unregister(el: HTMLMediaElement): void;
  registered(): PlayerRegistrationLike[];
  /**
   * Codex round-3 item 2 — the single-element counterpart to `registered()`,
   * for `player-adapter.ts`'s MutationObserver to consult when an element is
   * (re-)added to the DOM. `registered()` alone only feeds the ONE-TIME seed
   * list `attachPlayerVitals` reads at construction; a customer's explicit
   * registration must also survive the element being moved between
   * containers, or unmounted and remounted, and neither is a "construction"
   * event. Returns `undefined` for an element with no explicit registration
   * (an auto-attached one), same as a missing `Map` entry.
   */
  lookup(el: HTMLMediaElement): PlayerRegistrationLike | undefined;
  clear(): void;
}

export function createPlayerRegistry(): PlayerRegistry {
  const ids = new WeakMap<HTMLMediaElement, string>();
  // STRONG on purpose, not a WeakMap like `ids` above: a customer's declared
  // name/integration for a player must survive the page dropping the element
  // without calling `detach()` — an SPA that unmounts and remounts the same
  // logical player (e.g. a route change) should get its identity back
  // automatically on remount, which a weak structure could not guarantee
  // (the entry could vanish between unmount and remount at the GC's
  // discretion). The cost of that guarantee is explicit: `detach()` is the
  // customer's own responsibility for a player they never intend to see
  // again, and only `destroy()` (the lifecycle end) clears this map
  // wholesale — `kill()` deliberately does NOT: it means stop sending data,
  // not discard the customer's declared intent about which players they
  // care about (see vitals/index.ts's module header and its `destroy()`).
  const explicit = new Map<HTMLMediaElement, PlayerRegistrationLike>();
  let next = 1;
  return {
    idFor(el) {
      let id = ids.get(el);
      if (!id) { id = `p${next++}`; ids.set(el, id); }
      return id;
    },
    register(r) {
      // Mint the id FIRST, before writing to `explicit`: `idFor`'s
      // `WeakMap.set` is what throws on a bad key (e.g. `null`/`undefined`
      // — WeakMap rejects non-object keys), and it used to run AFTER
      // `explicit.set` succeeded. That ordering left a phantom entry
      // permanently in `explicit` on exactly the malformed input this
      // function exists to reject — `register` must not leave partial
      // state behind on failure; throwing before any write removes that
      // whole class of corruption rather than requiring every caller to
      // clean up after a half-completed call.
      const id = this.idFor(r.element);
      // Codex round-2 item 6 — this used to REPLACE the whole record, while
      // `player-adapter.ts`'s live `upgrade()` MERGES only the fields a
      // repeat call actually supplies (`if (opts?.name !== undefined) s.name
      // = opts.name`, etc.). That mismatch meant a bare second
      // `trackPlayer({element})` left a LIVE player still named and still
      // running its integration, but a collector restart (which rebuilds
      // every player from `registry.registered()`) recreated it anonymous
      // and native — collector timing alone changing what the same
      // registration means. Merge here the same way, so a field the new
      // call omits keeps whatever the registry already had for it, and the
      // two only ever agree.
      const existing = explicit.get(r.element);
      const merged: PlayerRegistrationLike = existing
        ? {
            element: r.element,
            ...(existing.name !== undefined ? { name: existing.name } : {}),
            ...(existing.integration !== undefined ? { integration: existing.integration } : {}),
            ...(r.name !== undefined ? { name: r.name } : {}),
            ...(r.integration !== undefined ? { integration: r.integration } : {}),
          }
        : r;
      explicit.set(r.element, merged);
      return id;
    },
    unregister(el) { explicit.delete(el); },
    registered() { return Array.from(explicit.values()); },
    lookup(el) { return explicit.get(el); },
    clear() { explicit.clear(); },
  };
}
