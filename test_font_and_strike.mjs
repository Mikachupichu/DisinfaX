import fs from 'fs';
import { KALAM_BOLD_LATIN_B64, KALAM_BOLD_LATIN_EXT_B64 } from './utils/correctionFont.ts';

const ARTIFACT_DIR = '/Users/michaelpouget/.gemini/antigravity/brain/120409ed-dc7a-46bb-9dfb-cecf73c722ae';
const SCRATCH_DIR = ARTIFACT_DIR + '/scratch';

function saveBoth(name, buf) {
  fs.writeFileSync(ARTIFACT_DIR + '/' + name, buf);
  fs.writeFileSync(SCRATCH_DIR + '/' + name, buf);
  console.log('Saved:', name, '(' + buf.length + ' bytes)');
}

async function main() {
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const redditTab = targets.find(t => t.type === 'page' && t.url.includes('reddit.com'));
  if (!redditTab) throw new Error('No Reddit tab');

  await fetch('http://127.0.0.1:9222/json/activate/' + redditTab.id);

  const ws = new WebSocket(redditTab.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 1;
  const send = (m, p={}) => new Promise(res => {
    const cur = id++;
    const h = (e) => {
      const d = JSON.parse(e.data);
      if (d.id === cur) { ws.removeEventListener('message', h); res(d.result); }
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: cur, method: m, params: p }));
  });

  await send('Page.enable');
  await send('Runtime.enable');

  console.log('1. Setting up @font-face and styles on Reddit...');
  const setupStyles = await send('Runtime.evaluate', {
    expression: `
      (() => {
        let style = document.getElementById('mf-test-font-styles');
        if (!style) {
          style = document.createElement('style');
          style.id = 'mf-test-font-styles';
          document.head.appendChild(style);
        }
        style.textContent = \`
          @font-face {
            font-family: "MFKalam";
            font-style: normal;
            font-weight: 700;
            font-display: swap;
            src: url(data:font/woff2;base64,${KALAM_BOLD_LATIN_EXT_B64}) format('woff2');
            unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
          }
          @font-face {
            font-family: "MFKalam";
            font-style: normal;
            font-weight: 700;
            font-display: swap;
            src: url(data:font/woff2;base64,${KALAM_BOLD_LATIN_B64}) format('woff2');
            unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
          }
          .mf-corr {
            display: inline !important;
            font: inherit !important;
            font-family: "MFKalam", "Segoe Print", "Bradley Hand", "Chalkboard SE", "Marker Felt", "Comic Sans MS", cursive !important;
            font-weight: 700 !important;
            font-size: 1.12em !important;
            line-height: 1 !important;
            vertical-align: baseline !important;
          }
          .mf-verdict-badge,
          .mf-verdict-badge *,
          .mf-inline-badge,
          .mf-inline-badge * {
            color: #ffffff !important;
          }
        \`;
        return { ok: true, fontCheck: document.fonts.check('16px MFKalam') };
      })()
    `,
    returnByValue: true
  });
  console.log('Setup styles result:', setupStyles.result.value);

  // Wait for font to load
  await send('Runtime.evaluate', {
    expression: `document.fonts.load('700 16px MFKalam')`,
    awaitPromise: true
  });

  console.log('2. Rendering multi-claim annotations in Reddit post title...');
  const renderRes = await send('Runtime.evaluate', {
    expression: `
      (() => {
        document.getElementById('test-strike-options')?.remove();
        document.getElementById('test-strike-container')?.remove();
        const post = document.querySelector('shreddit-post');
        const titleA = post?.querySelector('[slot="title"]') || post?.querySelector('a[id*="post-title"]');
        if (!titleA) return { error: 'no titleA' };

        titleA.style.lineHeight = '1.8';
        titleA.style.fontSize = '18px';
        titleA.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        titleA.style.display = 'block';
        titleA.style.position = 'relative';

        // Render both claims with exact classes, strikethroughs, corrections, caps and badges
        // Spacing on badge:
        // Top: 2px, Bottom: 2px, Right: 2px (matching top and bottom)
        titleA.innerHTML = \`
          <span class="mf-segment-wrap" style="-webkit-box-decoration-break: slice; box-decoration-break: slice; border-radius: 3px; padding: 1px 0px;">
            <span class="mf-segment-claim" style="background-color: rgba(255, 0, 0, 0.45); -webkit-box-decoration-break: slice; box-decoration-break: slice; border-top-left-radius: 3px; border-bottom-left-radius: 3px; border-top-right-radius: 999px; border-bottom-right-radius: 999px; padding: 1px 2px 1px 3px; cursor: pointer; transition: background-color 150ms ease-in-out; position: relative;">Albert Einstein <span class="mf-strike mf-strike-h" style="position: relative; display: inline; text-decoration: none; white-space: normal;">definitively proved in 1921 that the Earth is completely flat</span> <span class="mf-corr" style="color: rgb(244, 33, 46); font-weight: 700; margin: 0 4px;">developed the theory of general</span> <span style="white-space: nowrap;"><span class="mf-corr" style="color: rgb(244, 33, 46); font-weight: 700; margin: 0 4px 0 0;">relativity</span><span class="mf-badge-cap" style="display: inline-flex; align-items: center; vertical-align: middle; padding: 0; margin: 0; position: relative; top: 0;"><span class="mf-inline-badge mf-verdict-badge" style="display: inline-block; position: relative; top: -0.142em; line-height: 1.15; padding: 0.12em 0.52em; border-radius: 999px; background-color: rgba(0, 0, 0, 0.7); color: rgb(255, 255, 255); font-size: 0.75em; font-weight: 600; margin-left: 0.22em; white-space: nowrap; user-select: none;">100% False</span></span></span></span>, and <span class="mf-segment-claim" style="background-color: rgba(255, 0, 0, 0.45); -webkit-box-decoration-break: slice; box-decoration-break: slice; border-top-left-radius: 3px; border-bottom-left-radius: 3px; border-top-right-radius: 999px; border-bottom-right-radius: 999px; padding: 1px 2px 1px 3px; cursor: pointer; transition: background-color 150ms ease-in-out; position: relative;">was awarded the Nobel Prize in Physics in 1921 <span class="mf-strike mf-strike-h" style="position: relative; display: inline; text-decoration: none; white-space: normal;">for proving that the Earth is completely flat</span> <span class="mf-corr" style="color: rgb(244, 33, 46); font-weight: 700; margin: 0 4px;">for his discovery of the law of the photoelectric</span> <span style="white-space: nowrap;"><span class="mf-corr" style="color: rgb(244, 33, 46); font-weight: 700; margin: 0 4px 0 0;">effect</span><span class="mf-badge-cap" style="display: inline-flex; align-items: center; vertical-align: middle; padding: 0; margin: 0; position: relative; top: 0;"><span class="mf-inline-badge mf-verdict-badge" style="display: inline-block; position: relative; top: -0.142em; line-height: 1.15; padding: 0.12em 0.52em; border-radius: 999px; background-color: rgba(0, 0, 0, 0.7); color: rgb(255, 255, 255); font-size: 0.75em; font-weight: 600; margin-left: 0.22em; white-space: nowrap; user-select: none;">100% False</span></span></span></span> across astronomy.
          </span>
        \`;

        // Render rounded SVG strikethrough lines on containerEl (titleA)
        // With SVG on containerEl, coordinates are globally accurate relative to titleA,
        // and lines will not be clipped by any inline box.
        // Each line segment gets stroke-linecap: round, extending slightly beyond the words.
        titleA.querySelectorAll('svg.mf-strike-svg').forEach(s => s.remove());
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'mf-strike-svg');
        svg.style.cssText = 'position: absolute !important; top: 0 !important; left: 0 !important; width: 100% !important; height: 100% !important; pointer-events: none !important; overflow: visible !important; z-index: 2 !important;';
        titleA.appendChild(svg);

        const containerRect = titleA.getBoundingClientRect();
        const red = 'rgb(244, 33, 46)';

        document.querySelectorAll('.mf-strike.mf-strike-h').forEach(strike => {
          const rects = strike.getClientRects();
          for (let i = 0; i < rects.length; i++) {
            const r = rects[i];
            if (r.width <= 0 || r.height <= 0) continue;
            // Pad by 2px on each side for optical coverage and round cap extension
            const x1 = (r.left - containerRect.left) - 1.5;
            const x2 = (r.right - containerRect.left) + 1.5;
            const y = (r.top - containerRect.top) + (r.height * 0.52);

            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', String(x1));
            line.setAttribute('y1', String(y));
            line.setAttribute('x2', String(x2));
            line.setAttribute('y2', String(y));
            line.setAttribute('stroke', red);
            line.setAttribute('stroke-width', '2.4');
            line.setAttribute('stroke-linecap', 'round');
            svg.appendChild(line);
          }
        });

        titleA.scrollIntoView({ behavior: 'instant', block: 'center' });
        return { ok: true };
      })()
    `,
    returnByValue: true
  });
  console.log('Render result:', renderRes.result.value);

  await new Promise(r => setTimeout(r, 600));

  // Measure badges
  const measureRes = await send('Runtime.evaluate', {
    expression: `
      (() => {
        return Array.from(document.querySelectorAll('.mf-inline-badge')).map(b => {
          const claim = b.closest('.mf-segment-claim');
          const rects = claim.getClientRects();
          const lastLine = rects[rects.length - 1];
          const bRect = b.getBoundingClientRect();
          return {
            text: b.innerText,
            topDist: Math.round((bRect.top - lastLine.top) * 100) / 100,
            bottomDist: Math.round((lastLine.bottom - bRect.bottom) * 100) / 100,
            rightDist: Math.round((lastLine.right - bRect.right) * 100) / 100
          };
        });
      })()
    `,
    returnByValue: true
  });
  console.log('Badge measurements (top, bottom, right spacing):', measureRes.result.value);

  // Capture screenshot of the post title
  const boxRes = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const post = document.querySelector('shreddit-post');
        const titleA = post?.querySelector('[slot="title"]') || post?.querySelector('a[id*="post-title"]');
        titleA.scrollIntoView({ behavior: 'instant', block: 'center' });
        const r = titleA.getBoundingClientRect();
        return {
          x: Math.max(0, Math.floor(r.x - 16)),
          y: Math.max(0, Math.floor(r.y - 16)),
          width: Math.ceil(r.width + 32),
          height: Math.ceil(r.height + 32)
        };
      })()
    `,
    returnByValue: true
  });
  const box = boxRes.result.value;
  console.log('Box:', box);

  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    clip: {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      scale: 2
    }
  });
  const rawBuf = Buffer.from(shot.data, 'base64');
  saveBoth('crop-multi-claim-passage.png', rawBuf);
  saveBoth('multi-claim-rendered-settled.png', rawBuf);

  // Get rects for individual crops
  const rectsRes = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const wrap = document.querySelector('.mf-segment-wrap');
        const claims = Array.from(document.querySelectorAll('.mf-segment-claim'));
        const strikes = Array.from(document.querySelectorAll('.mf-strike'));
        const badges = Array.from(document.querySelectorAll('.mf-inline-badge'));

        const rWrap = wrap.getBoundingClientRect();
        return {
          wrap: { x: rWrap.x, y: rWrap.y, w: rWrap.width, h: rWrap.height },
          claims: claims.map(c => {
            const r = c.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
          }),
          strikes: strikes.map(s => {
            const r = s.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height, text: s.textContent };
          }),
          badges: badges.map(b => {
            const r = b.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height, text: b.textContent };
          })
        };
      })()
    `,
    returnByValue: true
  });
  const rects = rectsRes.result.value;
  fs.writeFileSync(SCRATCH_DIR + '/rects.json', JSON.stringify(rects));

  ws.close();
  console.log('Done rendering, now generating crops...');
}

main().catch(console.error);
