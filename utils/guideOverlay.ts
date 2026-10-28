/** The "how to fact-check" guide the popup draws over itself, and whether it is still owed.
 *
 *  The app wrapper draws the same guide over its panes, and the two must not disagree: one tap
 *  dismisses both, and doing the thing the guide describes dismisses both. So on Safari this is
 *  not the extension's own state at all — it is the shared one, read and written through the
 *  native host (see `GUIDE_STATE` / `DISMISS_GUIDE_OVERLAY`). Nowhere else is there anything to
 *  share with, so those builds keep the same two facts in extension storage.
 *
 *  Only imported from `import.meta.env.SAFARI` branches where the answer comes from the app, so
 *  the native import is tree-shaken out of the Chromium and Firefox bundles.
 */
import { browser } from 'wxt/browser';
import { callNativeHost } from './nativeHost';

/** Whether a webpage selection has ever been fact-checked on this install.
 *
 *  The extension's own record of it. On Safari the app keeps the authoritative copy — the
 *  background writes it there as well as here — because that is what its overlay is gated on.
 */
export const SELECTION_FACT_CHECK_KEY = 'mf_selection_fact_check_ever';

/** Whether the guide was tapped away on a build with no app to share it with. */
const DISMISSED_KEY = 'mf_fact_check_guide_dismissed';

/** What decides the guide, as the two facts that can actually change it. The app's third
 *  subject — the setup steps — is not asked about: those describe getting the extension into
 *  Safari, and a popup that is open over the page has already answered them. */
interface GuideState {
  selectionFactCheck: boolean;
  dismissed: boolean;
}

const UNAVAILABLE: GuideState = { selectionFactCheck: false, dismissed: false };

async function readState(): Promise<GuideState> {
  if (import.meta.env.SAFARI) {
    // An unreachable app answers this with an error, which leaves the guide unshown rather
    // than shown on a guess.
    const reply = await callNativeHost(
      { action: 'FACT_CHECK_GUIDE_STATE' },
      { type: 'MF_NATIVE_FACT_CHECK_GUIDE_STATE' },
    );
    if (typeof reply?.selectionFactCheck !== 'boolean') return UNAVAILABLE;
    return { selectionFactCheck: reply.selectionFactCheck, dismissed: reply.dismissed === true };
  }

  const stored = await browser.storage.local.get([SELECTION_FACT_CHECK_KEY, DISMISSED_KEY]);
  return {
    selectionFactCheck: stored[SELECTION_FACT_CHECK_KEY] === true,
    dismissed: stored[DISMISSED_KEY] === true,
  };
}

/** Whether the popup owes its overlay: the same rule the app applies to the same subject, read
 *  from the same record on Safari so the two surfaces can never disagree about it. */
export async function factCheckGuideDue(): Promise<boolean> {
  try {
    const state = await readState();
    return !state.selectionFactCheck && !state.dismissed;
  } catch {
    return false;
  }
}

/** Records the tap that silences the guide for good, on both surfaces at once on Safari. */
export async function dismissFactCheckGuide(): Promise<void> {
  try {
    if (import.meta.env.SAFARI) {
      await callNativeHost(
        { action: 'DISMISS_FACT_CHECK_GUIDE' },
        { type: 'MF_NATIVE_DISMISS_FACT_CHECK_GUIDE' },
      );
      return;
    }
    await browser.storage.local.set({ [DISMISSED_KEY]: true });
  } catch {
    // Best-effort on purpose: the overlay is already off screen, and the worst case is that
    // it is drawn once more at the next open.
  }
}
