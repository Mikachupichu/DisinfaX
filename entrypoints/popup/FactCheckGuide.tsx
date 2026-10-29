import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from './i18n';
import { useResolvedScheme } from './theme';

/** DisinfaX's mark, sized to the sentence it sits in. The app's guide inlines the same asset at
 *  twelve points beside the words that name the product, so the two surfaces show the same mark
 *  in the same place rather than one of them naming it in text alone.
 *
 *  The asset is the white one, because the guide's scrim is dark in the light appearance. In the
 *  dark appearance the scrim turns white and the mark is inverted to sit on it as the app's does. */
const BrandMark = ({ inverted }: { inverted: boolean }) => (
  <img
    src="/icon/96-white.png"
    alt=""
    aria-hidden="true"
    className={'inline-block h-[1.15em] w-[1.15em] align-[-0.09em]' + (inverted ? ' invert' : '')}
  />
);

/** The iOS version Safari reports, or 0 where the agent names none.
 *
 *  Only ever a fallback: Safari froze this string, so a phone keeps reporting the version it
 *  shipped with and two systems that draw the extensions button differently read alike here.
 *  `useIosMajor` asks the app instead. */
function iosMajorVersion(): number {
  const match = /OS (\d+)_/.exec(navigator.userAgent);
  return match ? Number(match[1]) : 0;
}

/** True on iPad, iPadOS included — it names itself "MacIntel" like a Mac. */
function isIPad(): boolean {
  try {
    return /iPad/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  } catch {
    return false;
  }
}

/** Safari's extensions button, drawn on the app's own twelve-point canvas so both surfaces name
 *  the control with the same drawing rather than each transcribing it.
 *
 *  A narrow bar — every phone — draws the button itself: a filled puzzle piece over the menu's two
 *  lines. The piece is the one that system draws, so it is smaller from iOS 27 on and larger
 *  before it, exactly as the app picks between the two.
 *
 *  A wide bar — an iPad — shows the puzzle piece alone, outline only and with no lines beneath it,
 *  which is the glyph the button becomes once it has the room. */
const PIECE_IOS_27 =
  'M2.95 1.5H6.09A.9.9 0 0 1 6.99 2.4V2.85A.75.75 0 0 1 6.99 4.35V4.8A.9.9 0 0 1 6.09 5.7H2.95A.9.9 0 0 1 2.05 4.8V4.35A.75.75 0 0 0 2.05 2.85V2.4A.9.9 0 0 1 2.95 1.5Z';
const PIECE_EARLIER =
  'M3.32 0.5H8.48A1.42 1.42 0 0 1 9.9 1.92V2.8A1.2 1.2 0 0 1 9.9 5.2V6.08A1.42 1.42 0 0 1 8.48 7.5H3.32A1.42 1.42 0 0 1 1.9 6.08V5.2A1.2 1.2 0 0 0 1.9 2.8V1.92A1.42 1.42 0 0 1 3.32 0.5Z';
/** A knob on each side, a notch cut into the top and the bottom — SF Symbols' `puzzlepiece`. */
const PIECE_WIDE_BAR =
  'M3.5 1.7H4.95A1.05 1.05 0 0 0 7.05 1.7H8.5A.6.6 0 0 1 9.1 2.3V4.95A1.05 1.05 0 0 1 9.1 7.05V9.7A.6.6 0 0 1 8.5 10.3H7.05A1.05 1.05 0 0 0 4.95 10.3H3.5A.6.6 0 0 1 2.9 9.7V7.05A1.05 1.05 0 0 1 2.9 4.95V2.3A.6.6 0 0 1 3.5 1.7Z';
const MENU_LINES = 'M2.05 9h7.9M2.05 11.25h4.7';

/** Where the answer is kept, so the mark is right from the first frame on every opening after
 *  the first. Same storage the popup already keeps under `App.tsx`'s keys. */
const OS_MAJOR_STORAGE_KEY = 'disinfax_ios_major';

/** How long the mark waits for the app's answer before falling back to the user agent.
 *  A message inside the extension, so this is not a latency budget: it is the point past which
 *  a handler that has not answered is treated as absent rather than left to arrive late and
 *  swap the drawing under the reader. Generous because the direct transport is tried first and
 *  on iOS it is accepted without ever calling back — the reply comes from the relay behind it. */
const OS_MAJOR_WAIT_MS = 3000;

function cachedIosMajor(): number | null {
  try {
    const stored = Number(localStorage.getItem(OS_MAJOR_STORAGE_KEY));
    return Number.isInteger(stored) && stored > 0 ? stored : null;
  } catch {
    return null;
  }
}

/** The iOS major version to draw for — the same one the app's own instructions draw for.
 *
 *  Null until it is known. The app is asked rather than the browser because Safari froze the
 *  user agent: the string reports the version the phone shipped with, so an iPhone running 27
 *  is indistinguishable there from one running 26, and the two draw Safari's extensions button
 *  differently. The user agent is still the answer when no handler replies. */
function useIosMajor(ios: boolean): number | null {
  const [major, setMajor] = useState<number | null>(() => (ios ? cachedIosMajor() : null));
  useEffect(() => {
    if (!ios) return;
    let live = true;
    const fallback = iosMajorVersion();
    (async () => {
      let answer: number | null = null;
      try {
        const { readNativeOsMajor } = await import('../../utils/nativeSession');
        answer = await Promise.race([
          readNativeOsMajor(),
          new Promise<null>(resolve => setTimeout(() => resolve(null), OS_MAJOR_WAIT_MS)),
        ]);
      } catch { /* the fallback is the answer */ }
      if (!live) return;
      if (answer !== null) {
        try { localStorage.setItem(OS_MAJOR_STORAGE_KEY, String(answer)); } catch { /* best-effort */ }
        setMajor(answer);
        return;
      }
      // Not cached: a guess from a frozen string would outlive the update that changed it.
      setMajor(current => current ?? fallback);
    })();
    return () => { live = false; };
  }, [ios]);
  return major;
}

const ExtensionsGlyph = ({ major }: { major: number | null }) => {
  const wideBar = isIPad();
  // Not known yet: draw the mark's space and nothing in it, so the sentence does not reflow
  // when the answer lands — and so the wrong drawing is never shown, however briefly.
  if (!wideBar && major === null) {
    return <span aria-hidden="true" className="inline-block h-[1em] w-[1em] align-[-0.12em]" />;
  }
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 12 12"
      className="inline-block h-[1em] w-[1em] align-[-0.12em]"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {wideBar ? (
        <path strokeWidth="1.15" d={PIECE_WIDE_BAR} />
      ) : (
        <>
          <path
            d={major !== null && major > 0 && major < 27 ? PIECE_EARLIER : PIECE_IOS_27}
            fill="currentColor"
            fillOpacity="0.667"
            stroke="none"
          />
          <path strokeWidth="1.15" d={MENU_LINES} />
        </>
      )}
    </svg>
  );
};

/** A space that is not a line break. It is what binds a mark to the word it names, in either
 *  direction — a logo left at the end of a line says nothing about the word on the next one. */
const NBSP = '\u00A0';

/** A translated sentence with its inline marks at `{1}`, `{2}`, … — the same convention the
 *  app's guide uses, so the translations are the app's and each language places the mark
 *  itself rather than inheriting English word order.
 *
 *  A mark is drawn tight against the word it names, with no space between them — the gap is a
 *  break opportunity, and a mark sits beside its word rather than near it. The space it was
 *  written with is dropped. The space BEFORE a mark stays and is a no-break one, because a
 *  language may put the mark before the word it names or after it and neither may be separated
 *  from it by a break. */
function marked(text: string, marks: React.ReactNode[]): React.ReactNode {
  // Splitting on a capture group interleaves the runs: even indices are text, odd ones are the
  // marker digits themselves.
  const parts = text.split(/\{(\d)\}/);
  const out: React.ReactNode[] = [];
  let index = 0;
  while (index < parts.length) {
    if (index % 2 === 0) {
      // The space before a mark is part of the mark's run, so it is not a place the line ends.
      const marker = parts[index + 1];
      const bound = marker !== undefined && marks[Number(marker) - 1] !== undefined;
      out.push(bound ? parts[index].replace(/ $/, NBSP) : parts[index]);
      index += 1;
      continue;
    }
    const mark = marks[Number(parts[index]) - 1];
    if (mark === undefined) {
      out.push(`{${parts[index]}}`);
      index += 1;
      continue;
    }
    // The mark and the word after it are one box that cannot break. A no-break space is not
    // enough on its own: an image is an atomic inline, and a browser is free to break beside one
    // whatever character follows it — which leaves the logo at the end of a line and the word it
    // names at the start of the next.
    const following = parts[index + 1] ?? '';
    // Group 2 is the word alone: the spaces the translation put between the marker and it are
    // dropped, so the mark is drawn against the word rather than a space away from it.
    const word = /^(\s*)(\S+)/.exec(following);
    out.push(
      <span key={`mark-${index}`} className="whitespace-nowrap">
        {mark}{word ? word[2] : ''}
      </span>,
    );
    out.push(word ? following.slice(word[0].length) : following);
    index += 2;
  }
  return out;
}

/** The panel's own colours, as literals rather than utility shades.
 *
 *  The popup re-points `white`, `zinc-100` and `zinc-400` for its light appearance (see
 *  `style.css`), so `text-white` here would be dark ink there and the guide would vanish into its
 *  own scrim. The guide instead takes the opposite of the appearance it covers, exactly as the
 *  app's does: a black scrim under white ink over the light panel, a white scrim under black ink
 *  over the dark one. */
function palette(dark: boolean) {
  return dark
    ? {
        scrim: 'bg-[rgba(255,255,255,0.8)]',
        ink: 'text-[#000000]',
        bodyInk: 'text-[#0a0a0a]',
        numberInk: 'text-[rgba(0,0,0,0.62)]',
      }
    : {
        scrim: 'bg-[rgba(0,0,0,0.8)]',
        ink: 'text-[#ffffff]',
        bodyInk: 'text-[#f4f4f5]',
        numberInk: 'text-[#a1a1aa]',
      };
}

/** The heading, drawn as wide as the panel allows — the app's overlay fits its own title to the
 *  space the same way, and a fixed size would centre one translation and push another off.
 *
 *  Measured rather than guessed: how much of the width a heading uses depends on the language,
 *  and the first estimate is corrected from the width actually drawn, because small glyphs draw
 *  slightly wider per point than large ones. */
function FitHeading({ text, ink }: { text: string; ink: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState(0);

  useLayoutEffect(() => {
    const fit = () => {
      const room = frame.current?.clientWidth ?? 0;
      const el = probe.current;
      if (!room || !el) return;
      el.style.fontSize = '100px';
      const natural = el.scrollWidth;
      if (!natural) return;
      // Close enough that the correction below lands in one step, and short of exactly fitting
      // so a rounding of that far cannot push the text past the frame and truncate it.
      const first = (100 * room * 0.99) / natural;
      el.style.fontSize = `${first}px`;
      const drawn = el.getBoundingClientRect().width || (natural * first) / 100;
      setSize(Math.min(120, (first * (room * 0.997)) / drawn));
    };
    fit();
    const observer = new ResizeObserver(fit);
    if (frame.current) observer.observe(frame.current);
    return () => observer.disconnect();
  }, [text]);

  return (
    <div ref={frame} className="relative w-full">
      <span
        ref={probe}
        aria-hidden="true"
        className={`pointer-events-none absolute left-0 top-0 whitespace-nowrap font-black opacity-0 ${ink}`}
      >
        {text}
      </span>
      <div
        className={`whitespace-nowrap text-center font-black leading-none ${ink}`}
        style={size ? { fontSize: `${size}px` } : { visibility: 'hidden' }}
      >
        {text}
      </div>
    </div>
  );
}

/** A mark that opens a sentence — the extensions button, on iOS.
 *
 *  A mark that stands in for the word beside it — the logo before "Disinfact" — is held to that
 *  word, which is the first one in `text`. A control out of Safari's own chrome names no word:
 *  the extensions button IS the thing being pointed at, so it takes an ordinary space on each
 *  side and reads as a word of its own (`spaced`). */
function MarkLeading({ mark, text, marks, spaced = false }: {
  mark: React.ReactNode;
  text: string;
  marks: React.ReactNode[];
  spaced?: boolean;
}) {
  if (spaced) {
    return (
      <>
        {mark}
        {' '}
        {marked(text.replace(/^\s+/, ''), marks)}
      </>
    );
  }
  const word = /^(\s*)(\S+)/.exec(text);
  return (
    <>
      <span className="whitespace-nowrap">{mark}{word ? word[2] : ''}</span>
      {marked(word ? text.slice(word[0].length) : text, marks)}
    </>
  );
}

/** One numbered instruction, on the baseline its number sits on. */
function Step({ n, numberInk, bodyInk, children }: {
  n: number;
  numberInk: string;
  bodyInk: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className={`w-[18px] shrink-0 text-right text-[13px] font-bold ${numberInk}`}>{n}.</span>
      <p className={`flex-1 text-[13px] leading-snug ${bodyInk}`}>{children}</p>
    </div>
  );
}

/** The darkening the signed-in popup wears until the guide has been read and the thing it
 *  describes has been done.
 *
 *  The whole popup is covered, footer included: this is the popup asking to be read before it is
 *  used, and a live control left legible on top of a dead panel reads as a bug rather than as a
 *  request. Unlike the app's panel there is no strip below it to point at, so the instructions
 *  come with it and the heading is centred over them.
 *
 *  The tap dismisses both surfaces: on Safari the dismissal is written to the shared store the
 *  app reads. */
export default function FactCheckGuide({ ios, onDismiss }: { ios: boolean; onDismiss: () => void }) {
  const t = useT();
  // The popup's own Appearance setting, not the system's: this panel is drawn over the popup and
  // has to answer the appearance the popup is actually showing.
  const dark = useResolvedScheme() === 'dark';
  const colors = palette(dark);
  const brand = <BrandMark key="brand" inverted={dark} />;
  const iosMajor = useIosMajor(ios);

  // The steps are the app guide's own, for this platform's way of starting a fact-check: on a
  // phone there is no right-click, so the second step names the extensions button the app's
  // guide names there. Chromium and Firefox show the mark beside the menu entry's name, which
  // is how the entry is drawn once it is in the menu.
  const second = ios
    ? (
      <>
        {t('guideTapSelectedPrefix').replace(/ $/, NBSP)}
        <MarkLeading mark={<ExtensionsGlyph major={iosMajor} />} text={t('guideTapSelectedSuffix')} marks={[brand]} spaced />
      </>
    )
    : !import.meta.env.SAFARI
      ? marked(t('guideRightClickLogo'), [brand])
      : t('guideRightClick');

  return (
    <div
      role="button"
      tabIndex={0}
      className={`absolute inset-0 z-50 flex cursor-pointer flex-col items-center justify-center px-6 ${colors.scrim}`}
      onClick={() => { onDismiss(); }}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') onDismiss();
      }}
    >
      <FitHeading text={t('guideHowToFactCheck')} ink={colors.ink} />
      <div className="mt-7 w-full space-y-3">
        <Step n={1} numberInk={colors.numberInk} bodyInk={colors.bodyInk}>{t('guideSelectText')}</Step>
        <Step n={2} numberInk={colors.numberInk} bodyInk={colors.bodyInk}>{second}</Step>
        <Step n={3} numberInk={colors.numberInk} bodyInk={colors.bodyInk}>{t('guideCharged')}</Step>
      </div>
    </div>
  );
}
