import React, { useLayoutEffect, useRef, useState } from 'react';
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
    className={`inline-block h-[1.15em] w-[1.15em] align-[-0.17em]${inverted ? ' invert' : ''}`}
  />
);

/** Safari's extensions button as its own drawing, transcribed from the app's guide: a rounded
 *  card with a puzzle tab on one edge and the menu lines beneath it. Drawn rather than named
 *  because there is no character for it, and tinted with `currentColor` so it takes the
 *  surrounding sentence's colour exactly as a glyph would. */
const ExtensionsGlyph = () => (
  <svg
    aria-hidden="true"
    viewBox="0 0 12 12"
    className="inline-block h-[1em] w-[1em] align-[-0.12em]"
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path
      strokeWidth="1.15"
      d="M3.35 1.1H8.65A1.3 1.3 0 0 1 9.95 2.4V2.525A1.2 1.2 0 0 1 9.95 4.925V5.05A1.3 1.3 0 0 1 8.65 6.35H3.35A1.3 1.3 0 0 1 2.05 5.05V4.925A1.2 1.2 0 0 0 2.05 2.525V2.4A1.3 1.3 0 0 1 3.35 1.1Z"
    />
    <path strokeWidth="1.15" d="M2.05 9h7.9M2.05 11.25h4.7" />
  </svg>
);

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

  // The steps are the app guide's own, for this platform's way of starting a fact-check: on a
  // phone there is no right-click, so the second step names the extensions button the app's
  // guide names there. Chromium and Firefox show the mark beside the menu entry's name, which
  // is how the entry is drawn once it is in the menu.
  const second = ios
    ? (
      <>
        {t('guideTapSelectedPrefix').replace(/ $/, NBSP)}
        <MarkLeading mark={<ExtensionsGlyph />} text={t('guideTapSelectedSuffix')} marks={[brand]} spaced />
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
