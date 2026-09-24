import React from 'react';

function strikethroughDiagClass(sub: string): string {
  let h = 0;
  for (let i = 0; i < sub.length; i++) h = (h * 31 + sub.charCodeAt(i)) | 0;
  return (h & 1) === 0 ? 'mf-diag-a' : 'mf-diag-b';
}

function strikethroughWordCount(sub: string): number {
  return sub.trim().split(/\s+/).filter(Boolean).length;
}

/** `{[inner]}` is an insert-only correction: keep the keyed substring,
 *  paint `inner` after it, no strikethrough. Ordinary values strike. */
function unwrapInsertOnlyCorrection(corr: string): { text: string; insertOnly: boolean } {
  const raw = String(corr ?? '');
  if (raw.startsWith('{[') && raw.endsWith(']}') && raw.length >= 4) {
    return { text: raw.slice(2, -2), insertOnly: true };
  }
  return { text: raw, insertOnly: false };
}

export type RawAnnotations =
  | Record<string, Record<string, string>>
  | Record<string, string>
  | undefined;

interface RangeItem {
  s: number;
  e: number;
  corr: string;
}

/** Extract range items relative to segStart from annotations object */
function extractRanges(
  annotations: RawAnnotations,
  textLength: number,
  segStart: number
): RangeItem[] {
  if (!annotations || typeof annotations !== 'object') return [];

  const pairs: Array<{ key: string; corr: string }> = [];

  for (const [key, val] of Object.entries(annotations)) {
    if (typeof val === 'string') {
      pairs.push({ key, corr: val });
    } else if (val && typeof val === 'object') {
      for (const [k, v] of Object.entries(val)) {
        if (typeof v === 'string') {
          pairs.push({ key: k, corr: v });
        }
      }
    }
  }

  const valid: RangeItem[] = [];
  for (const { key, corr } of pairs) {
    const m = /^(\d+),(\d+)$/.exec(key.trim());
    if (!m) continue;
    const absStart = parseInt(m[1], 10);
    const absEnd = parseInt(m[2], 10);
    if (isNaN(absStart) || isNaN(absEnd) || absEnd <= absStart) continue;

    const s = absStart - segStart;
    const e = absEnd - segStart;
    if (e <= 0 || s >= textLength) continue;

    valid.push({
      s: Math.max(0, s),
      e: Math.min(textLength, e),
      corr,
    });
  }

  // Sort by start position
  valid.sort((a, b) => a.s - b.s);
  return valid;
}

interface AnnotatedTextProps {
  text: string;
  annotations?: RawAnnotations;
  segStart?: number;
  className?: string;
}

/** Whether these annotations paint anything on this text.
 *
 *  A claim whose annotation dict holds a locale key but no ranges has been reviewed and
 *  found clean — the reader would otherwise see plain text and no sign that anything
 *  happened, which is why callers say so in words. */
export function hasAnnotationRanges(
  annotations: RawAnnotations,
  textLength: number,
  segStart = 0
): boolean {
  return extractRanges(annotations, textLength, segStart).length > 0;
}

export const AnnotatedText: React.FC<AnnotatedTextProps> = ({
  text,
  annotations,
  segStart = 0,
  className,
}) => {
  if (!text) return null;

  const ranges = extractRanges(annotations, text.length, segStart);
  if (ranges.length === 0) {
    return <span className={className}>{text}</span>;
  }

  const red = 'rgb(255, 60, 60)';
  const corrRed = 'rgb(255, 75, 75)';
  const elements: React.ReactNode[] = [];
  let cursor = 0;

  ranges.forEach((r, idx) => {
    // If range is behind cursor due to overlapping, skip or clamp
    if (r.s < cursor) {
      if (r.e <= cursor) return;
      r = { ...r, s: cursor };
    }

    // Text before the annotation
    if (r.s > cursor) {
      elements.push(
        <span key={`plain-${idx}`}>{text.slice(cursor, r.s)}</span>
      );
    }

    const sub = text.slice(r.s, r.e);
    const insert = unwrapInsertOnlyCorrection(r.corr);
    if (sub) {
      if (insert.insertOnly) {
        elements.push(<span key={`keep-${idx}`}>{sub}</span>);
      } else {
        const isSingleWord = strikethroughWordCount(sub) <= 1;
        if (isSingleWord) {
          elements.push(
            <span key={`strike-${idx}`} className="mf-strike">
              <span>{sub}</span>
              <span
                className={`mf-strike-line ${strikethroughDiagClass(sub)}`}
                style={{ backgroundColor: red }}
              />
            </span>
          );
        } else {
          elements.push(
            <span
              key={`strike-${idx}`}
              className="mf-strike mf-strike-h"
              style={{ textDecorationColor: red }}
            >
              {sub}
            </span>
          );
        }
      }
    }

    // Correction text. `{[…]}` is insert-only: trim the brackets, no strike.
    if (insert.text) {
      const shown = insert.text;
      // The spaces either side separate the correction from the words next to it — but only
      // where there is a word to separate it from. The struck span leaves the line and the space
      // that followed it does not, so an unconditional trailing space lands beside that one and
      // doubles it. (The page's paint and the app's `AnnotatedClaimText` write the same pair; the
      // guard belongs in all three.)
      const padBefore = sub !== '' && !/\s$/.test(sub);
      const padAfter = r.e < text.length && !/\s/.test(text[r.e]);
      elements.push(
        <span
          key={`corr-${idx}`}
          className="mf-corr"
          style={{ color: corrRed }}
        >
          {`${padBefore ? ' ' : ''}${shown}${padAfter ? ' ' : ''}`}
        </span>
      );
    }

    cursor = r.e;
  });

  if (cursor < text.length) {
    elements.push(
      <span key="plain-end">{text.slice(cursor)}</span>
    );
  }

  return <span className={className}>{elements}</span>;
};
