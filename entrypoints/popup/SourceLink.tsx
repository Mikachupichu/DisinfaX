import React, { useState } from 'react';

/** A source link with the source's favicon in front of its title.
 *
 *  Same three icon sources, in the same order, as the on-page links
 *  (createSourceLink in utils/injecting.ts): the site's own /favicon.ico first, then
 *  Google's and DuckDuckGo's favicon services, which exist because a great many sites
 *  serve no icon at any guessable path. Any of them can fail — no icon, a blocked
 *  request, a host that never answers — so the first letter of the domain is not a
 *  fallback for the icon but the one state that always renders.
 *
 *  The icon requests are third-party and necessarily name the domain being looked up;
 *  `referrerPolicy` at least keeps the referrer out of them. */
function faviconSources(domain: string): string[] {
  return [
    `https://${domain}/favicon.ico`,
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`,
    `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`,
  ];
}

/** The source's domain, for the letter that stands in for its icon. Falls back to the
 *  raw string when the url cannot be parsed — a malformed one still gets a letter. */
function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

interface SourceLinkProps {
  url: string;
  title: string;
}

export const SourceLink: React.FC<SourceLinkProps> = ({ url, title }) => {
  const domain = domainFromUrl(url);
  const sources = faviconSources(domain);

  const [sourceIndex, setSourceIndex] = useState(0);
  const [iconShown, setIconShown] = useState(false);

  const exhausted = sourceIndex >= sources.length;

  /** A response smaller than 2px across is a placeholder, not an icon (some hosts serve
   *  an empty body, some a transparent pixel), so it counts as a failure like any other
   *  and the chain moves on. */
  const onLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    if (event.currentTarget.naturalWidth > 1) {
      setIconShown(true);
    } else {
      setSourceIndex((i) => i + 1);
    }
  };

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-1.5 min-w-0 text-emerald-400 hover:text-emerald-300"
    >
      <span className="relative inline-flex h-4 w-4 flex-shrink-0 items-center justify-center overflow-hidden rounded-[3px] bg-zinc-800 text-[9px] font-semibold text-zinc-400">
        {(domain.charAt(0) || '?').toUpperCase()}
        {!exhausted && (
          <img
            key={sourceIndex}
            src={sources[sourceIndex]}
            alt=""
            referrerPolicy="no-referrer"
            onLoad={onLoad}
            onError={() => setSourceIndex((i) => i + 1)}
            className={`absolute inset-0 h-4 w-4 object-contain ${iconShown ? '' : 'hidden'}`}
          />
        )}
      </span>
      <span className="text-xs underline truncate">{title}</span>
    </a>
  );
};
