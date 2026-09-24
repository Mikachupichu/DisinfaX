import React, { useRef, useState } from 'react';
import { useT } from './i18n';

interface VerdictBadgeProps {
  confidence?: number;
  veracity?: number;
  className?: string;
}

const NEUTRAL_CHANNELS: readonly [number, number, number] = [180, 180, 180];

/** The badge's own class, the one the on-page badge carries: the reveal and hold rules in
 *  style.css are written against it. */
const BADGE_CLASS = 'mf-verdict-badge';

/** Put on the badge while the pointer is with it and its hover has widened it. Holds the
 *  adjective-less slots in the layout so the widening cannot flicker; see armHold. */
const BADGE_HOLD_CLASS = 'mf-badge-held';

/** Which of a badge template's positional arguments holds which piece of the label. */
type BadgeSlotRole = 'conf' | 'ver' | 'verdict';

/** Stand-ins for a template's arguments while its literal text is read back. These are
 *  control characters, so no locale string can contain one and the split stays exact. */
const BADGE_SENTINELS = ['\u0001', '\u0002', '\u0003'] as const;

type T = (key: string, subs?: string[]) => string;

/** The score as a whole percentage, for the hover swap. Veracity's sign is dropped:
 *  the verdict word already says true or false, so the magnitude is all that is left. */
function scorePercent(score: number): string {
  return `${Math.min(100, Math.max(0, Math.round(Math.abs(score) * 100)))}%`;
}

function getVerdictColorChannels(
  probability: number | undefined,
  veracity?: number
): readonly [number, number, number] {
  if (
    probability === undefined ||
    veracity === undefined ||
    probability === null ||
    veracity === null ||
    probability < 0.2
  ) {
    return NEUTRAL_CHANNELS;
  }

  const clampedVeracity = Math.max(-1, Math.min(1, veracity));
  const truthFraction = (clampedVeracity + 1) / 2;
  const saturation = Math.max(0, Math.min(1, probability));

  let r: number, g: number, b: number;
  if (truthFraction <= 0.5) {
    const ramp = truthFraction / 0.5;
    r = 255;
    g = Math.round(255 * ramp);
    b = 0;
  } else {
    const ramp = (truthFraction - 0.5) / 0.5;
    r = Math.round(255 * (1 - ramp));
    g = 255;
    b = 0;
  }

  const luminance = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  return [
    Math.round(luminance + (r - luminance) * saturation),
    Math.round(luminance + (g - luminance) * saturation),
    Math.round(luminance + (b - luminance) * saturation),
  ];
}

/** The adjectives, verdict word and locale template a badge should show for a pair of
 *  scores. A port of verdictBadgeParts in utils/injecting.ts, branch for branch, so the
 *  popup's badge and the on-page one never disagree about the same claim. */
type BadgeParts = {
  /** Template to lay the badge out with, plus the role each of its positional arguments
   *  plays. Null when no adjective applies and the badge is a bare word. */
  template: { key: string; roles: BadgeSlotRole[] } | null;
  verdict: string;
  confAdj: string | null;
  verAdj: string | null;
};

function verdictBadgeParts(t: T, probability: number, veracity?: number): BadgeParts {
  const trueLabel = t('verdictTrue');
  const falseLabel = t('verdictFalse');

  // Below 0.2 the model won't commit to a direction, whatever the veracity says.
  if (probability < 0.2) {
    return { template: null, verdict: t('verdictUnknown'), confAdj: null, verAdj: null };
  }

  if (veracity === undefined) {
    // Research has only landed one score: its magnitude reads as likelihood, and it takes
    // the template's single adjective slot, ahead of the verdict word.
    const abs = Math.abs(probability);
    let likelihoodKey: string | null;
    if (abs >= 0.9) likelihoodKey = null;
    else if (abs >= 0.8) likelihoodKey = 'VeryLikely';
    else if (abs >= 0.5) likelihoodKey = 'Likely';
    else likelihoodKey = 'Possibly';
    return {
      template: likelihoodKey ? { key: 'badgeAdjVerdict', roles: ['conf', 'verdict'] } : null,
      verdict: probability >= 0 ? trueLabel : falseLabel,
      confAdj: likelihoodKey ? t('adj' + likelihoodKey) : null,
      verAdj: null,
    };
  }

  let probKey: string | null = null;
  if (probability >= 0.9) probKey = null;
  else if (probability >= 0.8) probKey = 'VeryLikely';
  else if (probability >= 0.5) probKey = 'Likely';
  else probKey = 'Possibly';

  const absVer = Math.abs(veracity);
  let verKey: string | null = null;
  if (absVer >= 0.9) verKey = null;
  else if (absVer >= 0.8) verKey = 'Mostly';
  else if (absVer >= 0.5) verKey = 'Arguably';
  else if (absVer >= 0.2) verKey = 'Partially';
  else verKey = 'Equivocally';

  // A veracity of exactly 0 reads as "false", matching the on-page badge.
  const parts: BadgeParts = {
    template: null,
    verdict: veracity > 0 ? trueLabel : falseLabel,
    confAdj: probKey ? t('adj' + probKey) : null,
    verAdj: verKey ? t('adj' + verKey) : null,
  };
  if (probKey && verKey) {
    parts.template = {
      key: probKey === 'VeryLikely' ? 'badgeAdjVerdictAdj2Verbose' : 'badgeAdjVerdictAdj2',
      roles: ['ver', 'verdict', 'conf'],
    };
  } else if (probKey) {
    parts.template = { key: 'badgeVerdictAdj', roles: ['verdict', 'conf'] };
  } else if (verKey) {
    parts.template = { key: 'badgeAdjVerdict', roles: ['ver', 'verdict'] };
  }
  return parts;
}

/** Read a rendered badge template back as its literal runs and its argument slots.
 *
 *  Each argument is substituted as a sentinel rather than as its own text, so what comes
 *  back are exactly the literals this locale puts between the pieces (" to be " in en).
 *  Nothing about spacing or word order is assumed here. */
function parseBadgeTemplate(
  t: T,
  key: string,
  roles: BadgeSlotRole[]
): { role: BadgeSlotRole | null; text: string }[] {
  const rendered = t(key, roles.map((_, i) => BADGE_SENTINELS[i]));
  const pieces: { role: BadgeSlotRole | null; text: string }[] = [];
  let literal = '';
  for (const ch of rendered) {
    const idx = BADGE_SENTINELS.indexOf(ch as (typeof BADGE_SENTINELS)[number]);
    if (idx >= 0 && idx < roles.length) {
      pieces.push({ role: null, text: literal }, { role: roles[idx], text: '' });
      literal = '';
    } else {
      literal += ch;
    }
  }
  pieces.push({ role: null, text: literal });
  return pieces;
}

/** The locale's own separator between an adjective and the verdict word, reused for a
 *  slot the template has no position for. */
function verdictGlueFallback(t: T): string {
  const pieces = parseBadgeTemplate(t, 'badgeAdjVerdict', ['conf', 'verdict']);
  const at = pieces.findIndex((p) => p.role === 'conf');
  const after = pieces[at + 1];
  // With no slot to read from, the template key itself comes back as one literal; a plain
  // space is the safe separator then.
  return at >= 0 && after && after.role === null ? after.text : ' ';
}

type BadgeSlotPiece = { role: 'conf' | 'ver'; adj: string | null; glue: string; pct: string };
type BadgePiece = BadgeSlotPiece | { role: 'verdict'; glue: string };

/** Which part of a badge a point falls in: the slot or the verdict word it belongs to,
 *  rather than the node itself, since the widening moves no part out from under a point
 *  that stays within it. (badgePartOf, utils/injecting.ts.) */
function badgePartAt(x: number, y: number): Element | null {
  return document.elementFromPoint(x, y)?.closest('.mf-badge-verdict, .mf-badge-slot') ?? null;
}

export const VerdictBadge: React.FC<VerdictBadgeProps> = ({
  confidence,
  veracity,
  className = '',
}) => {
  const t = useT();
  const badgeRef = useRef<HTMLSpanElement | null>(null);

  // The hold: whether the badge is being kept open, and the hover that armed it. Kept in a
  // ref as well as in state because the settle frame and a release must read the hold that
  // exists now, not the one this render's closure was made with.
  const [held, setHeld] = useState(false);
  const heldRef = useRef(false);
  const holdRef = useRef<{ part: Element | null; x: number; y: number } | null>(null);

  const setHold = (on: boolean) => {
    heldRef.current = on;
    setHeld(on);
  };

  /** Watch a badge the pointer has just landed on for the move that hover costs it.
   *
   *  Hovering an adjective-less slot widens the badge, and the widening slides the badge's
   *  own parts out from under the pointer that widened it: the hover is lost, the badge
   *  shrinks back under the pointer, and it widens again — a flicker at frame rate. So the
   *  badge is held open until the pointer follows it or leaves it.
   *
   *  (Same watch as armBadgeHold in utils/injecting.ts, minus what a one-line pill in a fixed
   *  popup does not have: the page's line wrap and the band of the line a wrapped badge
   *  vacates, and the touch-tap read, since a tap here arrives as the hover it leaves behind.) */
  const armHold = (x: number, y: number, enteredOn: Element) => {
    const badge = badgeRef.current;
    // Only an adjective-less slot changes the badge's width, so only its reveal moves
    // anything. Hovering an adjective the badge already shows swaps it for its percentage,
    // which the slot's own width absorbs — arming on that would reveal a slot the pointer
    // never asked for.
    if (!badge || !badge.querySelector('.mf-badge-empty')) return;
    const alreadyHeld = heldRef.current;
    const hold = { part: enteredOn.closest('.mf-badge-verdict, .mf-badge-slot'), x, y };
    holdRef.current = hold;
    // The class goes on now, ahead of the recalc the reveal is waiting on, and not in the
    // frame after it: the reveal is exactly what the settle below has to measure. The state
    // set that follows is only there so a re-render keeps the class.
    badge.classList.add(BADGE_HOLD_CLASS);
    setHold(true);
    requestAnimationFrame(() => {
      // Released, or re-armed elsewhere, between the hover and this frame: not ours to settle.
      if (holdRef.current !== hold) return;
      // Whether the reveal cost the pointer anything is the whole question, and it is answered
      // by where the pointer is now against where its hover landed. The same part means nothing
      // moved, the hover itself is holding the reveal open, and the hold was never needed —
      // unless this badge was already held, in which case it is not this hover's to drop.
      if (!alreadyHeld && badgePartAt(x, y) === hold.part) releaseHold();
    });
  };

  const releaseHold = () => {
    holdRef.current = null;
    if (!heldRef.current) return;
    badgeRef.current?.classList.remove(BADGE_HOLD_CLASS);
    setHold(false);
  };

  if (confidence === undefined || confidence === null) {
    const [r, g, b] = NEUTRAL_CHANNELS;
    return (
      <span
        className={`${BADGE_CLASS} inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap ${className}`}
        style={{
          backgroundColor: `rgba(${r}, ${g}, ${b}, 0.15)`,
          color: `rgb(${r}, ${g}, ${b})`,
          border: `1px solid rgba(${r}, ${g}, ${b}, 0.3)`,
        }}
      >
        {t('verdictUnknown')}
      </span>
    );
  }

  const parts = verdictBadgeParts(t, confidence, veracity);
  const pieces = parts.template ? parseBadgeTemplate(t, parts.template.key, parts.template.roles) : [];

  // Walk the template in order, handing each literal run to the piece it follows.
  const order: BadgePiece[] = [];
  let current: BadgePiece | null = null;
  for (const piece of pieces) {
    if (!piece.role) {
      if (current) current.glue += piece.text;
      continue;
    }
    current =
      piece.role === 'verdict'
        ? { role: 'verdict', glue: '' }
        : {
            role: piece.role,
            adj: piece.role === 'conf' ? parts.confAdj : parts.verAdj,
            glue: '',
            pct: piece.role === 'conf' ? scorePercent(confidence) : scorePercent(veracity ?? 0),
          };
    order.push(current);
  }

  // A badge with no adjective at all ("True", "Unknown") has no template to walk, so the
  // verdict word goes in on its own and the slots are inserted ahead of it.
  if (!order.some((p) => p.role === 'verdict')) order.push({ role: 'verdict', glue: '' });

  // A score with no adjective still has a percentage worth showing, so its slot goes where
  // the template would have put it, borrowing the neighbouring slot's separator (or, with
  // no slot to copy, the plain adjective→verdict join).
  const wanted: BadgeSlotPiece[] = [
    { role: 'conf', adj: parts.confAdj, glue: '', pct: scorePercent(confidence) },
  ];
  if (veracity !== undefined) {
    wanted.push({ role: 'ver', adj: parts.verAdj, glue: '', pct: scorePercent(veracity) });
  }
  for (const slot of wanted) {
    if (order.some((p) => p.role === slot.role)) continue;
    const verAt = order.findIndex((p) => p.role === 'ver');
    const at = verAt >= 0 ? verAt : order.findIndex((p) => p.role === 'verdict');
    const neighbour = order[at];
    slot.glue =
      at >= 0 && neighbour && neighbour.role !== 'verdict' ? neighbour.glue : verdictGlueFallback(t);
    order.splice(at < 0 ? order.length : at, 0, slot);
  }

  const [r, g, b] = getVerdictColorChannels(confidence, veracity);

  return (
    <span
      ref={badgeRef}
      className={`${BADGE_CLASS} inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap${
        held ? ` ${BADGE_HOLD_CLASS}` : ''
      } ${className}`}
      style={{
        backgroundColor: `rgba(${r}, ${g}, ${b}, 0.15)`,
        color: `rgb(${r}, ${g}, ${b})`,
        border: `1px solid rgba(${r}, ${g}, ${b}, 0.3)`,
      }}
      onMouseOver={(e) => {
        const enteredOn = (e.target as Element).closest('.mf-badge-verdict, .mf-badge-empty');
        if (enteredOn) armHold(e.clientX, e.clientY, enteredOn);
      }}
      onMouseLeave={releaseHold}
    >
      {order.map((piece, i) => {
        const glue = piece.glue ? (
          <span className="mf-badge-glue" key={`glue-${i}`}>
            {piece.glue}
          </span>
        ) : null;
        if (piece.role === 'verdict') {
          return (
            <React.Fragment key={`verdict-${i}`}>
              <span className="mf-badge-verdict">{parts.verdict}</span>
              {glue}
            </React.Fragment>
          );
        }
        return (
          <span
            key={`${piece.role}-${i}`}
            className={`mf-badge-slot mf-badge-${piece.role}${
              piece.adj === null ? ' mf-badge-empty' : ''
            }`}
          >
            <span className="mf-badge-stack">
              {piece.adj !== null && <span className="mf-badge-adj">{piece.adj}</span>}
              <span className="mf-badge-pct">{piece.pct}</span>
            </span>
            {glue}
          </span>
        );
      })}
    </span>
  );
};
