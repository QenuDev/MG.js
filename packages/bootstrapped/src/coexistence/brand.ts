/**
 * Coexistence: telling your own hook apart from everyone else's.
 *
 * ## The problem this solves
 *
 * A mod that patches a shared object has to answer three questions at three different moments, and
 * getting any of them wrong breaks *someone else's* mod in a way that is extremely hard to trace:
 *
 *  1. **Before installing**: "is a hook already here, and is it mine?" A mod that reinstalls on a
 *     reconnect, or that toggles a feature off and on, will see its own wrapper in the slot. Wrapping it
 *     again produces a self-feeding chain: every send renumbered twice, every event delivered twice.
 *  2. **Before claiming**: "a function is in the slot; may I take it?" An unrecognised wrapper must be
 *     treated as foreign and *wrapped*, never replaced. Replacing it silently deletes another mod's
 *     feature, and the other mod has no way to detect that it happened.
 *  3. **On uninstall**: "is the thing in the slot still mine?" If another script layered its own hook
 *     on top of ours in the meantime (which is legitimate, and is what *we* do to the game),
 *     blindly restoring our captured "original" erases their hook as well. The symptom is "the other
 *     mod's feature randomly stops working after mine unloads", which as the recon notes is "a brutal
 *     one to trace back to its cause".
 *
 * ## The documented answer
 *
 * The protocol docs' §19, "A third refinement: brand your own wrapper", and its Appendix B give exactly
 * three helpers (a brander, a three-way classifier, and an identity-guarded restorer), reproduced
 * verbatim in the recon (`recon-quinoa-protocol.md` Appendix B). This module implements those three,
 * with the signatures the docs show, because a marker protocol only works when every mod agrees on
 * it. A mod that invents its own marker key cannot be detected by the other mods it shares a
 * page with.
 *
 * ## Why the marker key is what it is
 *
 * The docs' example uses `__myModWrapped` / `__myModLabel`. The names are illustrative: in a
 * page with several independent mods, *both* of those collide as surely as an unmarked slot does:
 * mod A's `__myModWrapped` and mod B's `__myModWrapped` are the same property. The marker is therefore
 * keyed by this package's own identity (`__mgjsWrapped`, from `MARKER_KEY` below), so
 * {@link classifySlot} answers "is this one of *mine*" rather than "is this one *someone's*". A foreign
 * wrapper carrying its own differently-named marker still classifies as `'foreign'`, which is the
 * conservative and correct answer.
 *
 * ## No page access
 *
 * This module is pure: it takes objects and keys and returns verdicts. It touches nothing on `window`,
 * so `tests/coexistence/renumber.test.ts` can exercise it with plain objects and no DOM.
 */

/**
 * The property name this package brands its wrappers with.
 *
 * Exported so a cooperating mod can recognise our hooks too. If every mod published a marker under a
 * *shared* name, the classification would collapse to "someone's", the ambiguity the docs' third
 * refinement exists to remove. We publish ours and read someone else's name as foreign.
 */
export const MARKER_KEY = '__mgjsWrapped';

/** Where the human-readable label is stored on a branded wrapper. */
export const MARKER_LABEL_KEY = '__mgjsLabel';

/**
 * A function carrying this package's brand.
 *
 * Intersected onto the wrapper's own type rather than replacing it, so branding never changes a
 * function's callable signature and a caller cannot accidentally type-narrow away the original.
 */
export type Branded<F> = F & {
  [MARKER_KEY]?: true;
  [MARKER_LABEL_KEY]?: string;
};

/** What the classifier found in a slot. */
export type SlotClass =
  /** Nothing installed, or something that is not a function. Safe to write directly. */
  | 'clean'
  /** A wrapper *this* build branded. Leave it alone: wrapping again would chain. */
  | 'mine'
  /** A function carrying no recognisable brand. Assume a third party; wrap, never replace. */
  | 'foreign';

/**
 * Brand a function as ours.
 *
 * The docs (§19): "Tag every function you install with a private marker, and check for your own marker
 * (not just 'is something installed') before deciding whether to wrap again."
 *
 * The brand is written with `Object.defineProperty` and `enumerable: false` rather than plain
 * assignment, for two reasons: the property must survive `JSON.stringify` of anything that
 * accidentally serialises the function's owner, and a non-enumerable marker cannot be clobbered by a
 * `{...spread}` or `Object.assign` copy of the object holding it, because a copy would lose the brand
 * and the hook would then be classified as foreign on the next install.
 *
 * @param fn the wrapper to brand. Non-functions are returned untouched, so a caller can brand a value
 *   it has not yet type-checked without a guard at every call site.
 * @param label a short human-readable identifier. It lands in the brand so a stack trace or a devtools
 *   inspection can say `__mgjsLabel: 'roomConnection.sendMessage'` instead of showing an anonymous
 *   wrapper. It is purely diagnostic: nothing branches on it.
 */
export function brandWrapper<T extends object>(fn: T, label: string): T {
  if (typeof fn !== 'function') return fn;
  try {
    Object.defineProperty(fn, MARKER_KEY, {
      value: true,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(fn, MARKER_LABEL_KEY, {
      value: label,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  } catch {
    // A frozen or exotic function (a bound function whose target is non-extensible) cannot be branded.
    // Returning it unbranded is the honest outcome: it will classify as foreign next time, which means
    // we wrap rather than replace, which is degraded but never destructive.
  }
  return fn;
}

/**
 * True when a value carries this package's brand.
 *
 * A positive test on our own marker only, by design. It is not "is this a function someone wrapped":
 * the docs are explicit that an unrecognised wrapper must be assumed foreign, and "has *some* wrapper
 * marker" is not something this can know.
 */
export function isBranded(value: unknown): boolean {
  if (typeof value !== 'function') return false;
  return (value as unknown as Record<string, unknown>)[MARKER_KEY] === true;
}

/** The label a branded wrapper carries, or `null`. Diagnostics only. */
export function brandLabelOf(value: unknown): string | null {
  if (!isBranded(value)) return null;
  const label = (value as unknown as Record<string, unknown>)[MARKER_LABEL_KEY];
  return typeof label === 'string' ? label : null;
}

/**
 * Classify what currently occupies `obj[key]`.
 *
 * The docs' implementation, with the two decisions it encodes preserved exactly:
 *
 *   - **Own-property check.** `hasOwnProperty` rather than `key in obj`. A hook slot may well be
 *     inherited (`WebSocket.prototype.send` is one as seen from a `WebSocket`
 *     instance), and a prototype-inherited function is not "installed", it is the original. Treating
 *     it as occupied would make every first install look like a conflict.
 *   - **Non-function is clean.** If some other script left a non-function in the slot, it is not a hook
 *     we can chain to or preserve. `'clean'` means "write something here"; the caller's own captured
 *     `previous` value is what preserves the oddity if it wants to.
 *
 * @param obj the object whose slot is being inspected.
 * @param key the property name.
 */
export function classifySlot(obj: object, key: string): SlotClass {
  if (!Object.hasOwn(obj, key)) return 'clean';
  const value = (obj as Record<string, unknown>)[key];
  if (typeof value !== 'function') return 'clean';
  // Per §19: "unrecognized wrapper = assume foreign, never claim it".
  return isBranded(value) ? 'mine' : 'foreign';
}

/**
 * The result of an {@link installHook} call.
 *
 * Returned rather than a bare `void` because the caller usually needs to know whether it installed
 * anything: a `'reused'` install must not be torn down by the caller that did not create it.
 */
export type InstallOutcome =
  /** We wrote a fresh wrapper over a clean or foreign slot. The handle owns the restore. */
  | 'installed'
  /** Our own wrapper was already there. Nothing was written; the existing handle owns the restore. */
  | 'reused';

/** The handle {@link installHook} returns. */
export interface InstalledHook {
  readonly outcome: InstallOutcome;
  /** The function actually in the slot, ours, whether just written or written by an earlier call. */
  readonly wrapper: unknown;
  /**
   * Restore the slot, identity-guarded.
   *
   * @returns `true` when the original was put back; `false` when somebody had wrapped us and the slot
   *   was therefore left alone by design. Safe to call more than once.
   */
  release(): boolean;
}

/**
 * The function a hook chains onto, typed so it can actually be called.
 *
 * The old signature declared `previous` with rest parameters of type `never`, which reads as "takes no
 * argument that can be supplied", so the function was *uncallable through its type*, and every chaining
 * site had to escape the type system to call it: three hand-written `as` casts across
 * `live-catalog/object-keys-source.ts`, `attach/raw-socket.ts` and `coexistence/renumber.ts`, plus an
 * indirect `Reflect` call in `tests/coexistence/renumber.test.ts`. `unknown[]` is the honest type of
 * "whatever shape the slot held", and the wrapper's author is the one who knows that shape; that is
 * the contract a hook API can keep.
 */
export type PreviousFn = (this: unknown, ...args: unknown[]) => unknown;

/** Options for {@link installHook}. */
export interface InstallHookOptions {
  /** The object holding the slot (e.g. `WebSocket.prototype`, or the room-connection object). */
  target: object;
  /** The property name (e.g. `'send'`, `'sendMessage'`). */
  key: string;
  /** Label for the brand, e.g. `'WebSocket.prototype.send'`. */
  label: string;
  /**
   * Build the wrapper, given the function currently in the slot.
   *
   * Called only when we are actually installing. `previous` is `undefined` when the slot held no
   * function, and is the function that was there otherwise, which for a `'foreign'` classification is
   * the other mod's wrapper, and must be called through rather than discarded. Its arguments are the
   * caller's responsibility: see {@link PreviousFn}.
   */
  wrap: (previous: PreviousFn | undefined) => (...args: unknown[]) => unknown;
}

/**
 * Install a branded, chained, identity-guarded hook.
 *
 * This is the composed form of the three documented helpers, and it is what every hook in this package
 * goes through. The full decision table:
 *
 * | slot holds | action |
 * |---|---|
 * | nothing / a non-function | write our branded wrapper |
 * | our branded wrapper | write nothing; report `'reused'` |
 * | an unbranded function | **chain**: build a wrapper that calls through to it, then write ours |
 *
 * The `'foreign'` branch is the one that matters most and the one the docs spend the most words on. The
 * other mod's function stays reachable (it is captured as `previous` and invoked by the wrapper), so a
 * mod that hooked `send` before us keeps working, and one that hooks after us keeps working too,
 * because our wrapper is itself just a function in a slot.
 */
export function installHook(options: InstallHookOptions): InstalledHook {
  const { target, key, label, wrap } = options;
  const existing = (target as Record<string, unknown>)[key];

  if (isBranded(existing)) {
    return { outcome: 'reused', wrapper: existing, release: () => false };
  }

  // A non-function in the slot is treated as absent for chaining purposes (see `classifySlot`), but it
  // is still captured so the restore can put it back exactly.
  const previous = typeof existing === 'function' ? (existing as PreviousFn) : undefined;
  const wrapper = brandWrapper(wrap(previous), label) as unknown;

  (target as Record<string, unknown>)[key] = wrapper;

  let released = false;
  return {
    outcome: 'installed',
    wrapper,
    release(): boolean {
      if (released) return false;
      released = true;
      return restoreSlot(target, key, existing, wrapper);
    },
  };
}

/**
 * Restore a slot, but only if it still holds the wrapper we installed.
 *
 * The docs' identity guard, verbatim in behaviour: "when tearing your hook down, only put the original
 * function back if the slot still holds exactly the wrapper you installed."
 *
 * Note `original` is typed `Function | undefined` and the `undefined` case is meaningful: it means the
 * slot was empty when we installed, so a correct restore *deletes* the property rather than assigning
 * `undefined` to it. That distinction is observable (`'send' in WebSocket.prototype` differs), and a
 * slot left as an own property holding `undefined` would classify as `'clean'` later but would still
 * shadow a prototype member, breaking the object it was installed on.
 *
 * @returns `true` when the slot was restored, `false` when it was left alone because someone had
 *   wrapped us (or because we were never there).
 */
export function restoreSlot(obj: object, key: string, original: unknown, installedRef: unknown): boolean {
  const record = obj as Record<string, unknown>;
  if (record[key] !== installedRef) return false;

  if (original === undefined) {
    delete record[key];
    return true;
  }
  record[key] = original;
  return true;
}

/**
 * Run a teardown step without letting its failure abort the rest.
 *
 * Teardown routinely touches things that are already gone: a socket that closed, a node the game
 * destroyed, a container the renderer recreated. Every one of those throws, and a teardown that stops
 * at the first throw leaves the *later* hooks installed forever. So the shape is always "attempt, log,
 * continue", and this is that shape in one place instead of repeated five times.
 *
 * A `console.warn` rather than silence: a teardown that fails is a bug worth seeing, but it is never
 * worth breaking the page for. `console` is assumed present; guarded because a userscript can run in
 * contexts that strip it.
 */
export function attemptTeardown(step: string, action: () => void): boolean {
  try {
    action();
    return true;
  } catch (error) {
    try {
      console.warn(`[mg.js] teardown step "${step}" threw; continuing.`, error);
    } catch {
      // No console. The step failed either way.
    }
    return false;
  }
}
