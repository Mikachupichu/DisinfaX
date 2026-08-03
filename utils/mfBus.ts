/** Private in-process event bus for the injected UI (utils/injecting.ts) and the
 *  relay content script (entrypoints/relay.content.ts) to talk to each other.
 *
 *  Both of those run in the SAME isolated content-script world and share this
 *  module instance, so a plain EventTarget is enough to connect them. Crucially,
 *  the host page's MAIN world (i.e. X itself, or any script/ad it loads) has NO
 *  reference to this object — unlike `document`, which is shared DOM that any page
 *  script can dispatch events on. Routing our functional events (fact-check-all,
 *  process-on-hold, reclassify, refresh, translate, locale-switch, …) through here
 *  instead of `document.dispatchEvent` means a malicious platform can no longer
 *  forge them to drive money-spending actions under the signed-in user or to spoof
 *  extension state. Visual `mf-*` CSS class names are unrelated and untouched. */
export const mfBus = new EventTarget();
