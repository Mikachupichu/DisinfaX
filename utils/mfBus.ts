/** Private in-process event bus for the injected UI (utils/injecting.ts) and the
 *  relay content script (entrypoints/relay.content.ts) to talk to each other.
 *
 *  Both of those run in the SAME isolated content-script world. Crucially, the host
 *  page's MAIN world (i.e. X itself, or any script/ad it loads) has NO reference to
 *  this object — unlike `document`, which is shared DOM that any page script can
 *  dispatch events on. Routing our functional events (fact-check-all, process-on-hold,
 *  reclassify, refresh, translate, locale-switch, …) through here instead of
 *  `document.dispatchEvent` means a malicious platform can no longer forge them to
 *  drive money-spending actions under the signed-in user or to spoof extension state.
 *  Visual `mf-*` CSS class names are unrelated and untouched.
 *
 *  ── Why this is a plain registry and not an EventTarget ──
 *
 *  It used to be `new EventTarget()`, which silently does not work in a Firefox content
 *  script. Measured directly, in the built extension: a listener attached to the bus and a
 *  `CustomEvent` dispatched on that same object one statement later never reached it —
 *
 *      const bus = new EventTarget();
 *      let fired = false;
 *      bus.addEventListener('x', () => { fired = true; }, { once: true });
 *      bus.dispatchEvent(new CustomEvent('x'));
 *      // fired === false, on Firefox only
 *
 *  The cause is a realm mismatch: a content script's `CustomEvent` and its script-created
 *  `EventTarget` sit on opposite sides of a wrapper boundary, so dispatch finds no
 *  listeners. Chromium and Safari are unaffected, which is why this only ever broke
 *  Firefox — and it broke EVERY mfBus-routed action there (Disinfact, Fact-Check All,
 *  reclassify, refresh, translate, locale switch), each failing the same silent way: the
 *  button switched to its spinner and the intent simply evaporated.
 *
 *  A plain callback registry has no DOM machinery and therefore no realms to cross. The
 *  addEventListener/dispatchEvent shape is kept deliberately so every existing call site
 *  — which still constructs `new CustomEvent(type, { detail })` — works unchanged; only
 *  `.type` and `.detail` are ever read from the object. */

type MfListener = (event: any) => void;

const listeners = new Map<string, Set<MfListener>>();

export const mfBus = {
    addEventListener(type: string, listener: MfListener, options?: { once?: boolean }): void {
        let set = listeners.get(type);
        if (!set) {
            set = new Set<MfListener>();
            listeners.set(type, set);
        }
        if (options?.once) {
            // Self-removing wrapper, so `{ once: true }` behaves as callers expect.
            const wrapped: MfListener = (event) => {
                set!.delete(wrapped);
                listener(event);
            };
            set.add(wrapped);
            return;
        }
        set.add(listener);
    },

    removeEventListener(type: string, listener: MfListener): void {
        listeners.get(type)?.delete(listener);
    },

    /** Iterates a copy, so a listener that adds or removes handlers cannot disturb the
     *  in-flight dispatch, and isolates throws: one failing listener must not prevent the
     *  others from running, which is exactly how EventTarget behaves. */
    dispatchEvent(event: { type: string }): boolean {
        const set = listeners.get(event.type);
        if (!set || set.size === 0) return true;
        for (const listener of Array.from(set)) {
            try {
                listener(event);
            } catch (err) {
                console.error(`[misinfo] mfBus listener for "${event.type}" threw`, err);
            }
        }
        return true;
    },
};
