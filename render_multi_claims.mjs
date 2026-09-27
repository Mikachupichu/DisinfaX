import fs from 'fs';

const ARTIFACT_DIR = '/Users/michaelpouget/.gemini/antigravity/brain/120409ed-dc7a-46bb-9dfb-cecf73c722ae';
const SCRATCH_DIR = ARTIFACT_DIR + '/scratch';

function saveBoth(name, buf) {
  fs.writeFileSync(ARTIFACT_DIR + '/' + name, buf);
  fs.writeFileSync(SCRATCH_DIR + '/' + name, buf);
  console.log('Saved:', name, '(' + buf.length + ' bytes)');
}

async function main() {
  // 1. Get cached classification from SW
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const swTab = targets.find(t => t.type === 'service_worker' && t.url.includes('background.js'));
  const redditTab = targets.find(t => t.type === 'page' && t.url.includes('reddit.com'));
  if (!swTab || !redditTab) throw new Error('Missing tabs');

  const swWs = new WebSocket(swTab.webSocketDebuggerUrl);
  await new Promise(r => swWs.onopen = r);
  const swRes = await new Promise(res => {
    swWs.onmessage = (e) => res(JSON.parse(e.data).result);
    swWs.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression: `(() => {
          const hit = globalThis.__classificationCache.get('sel_1790356960341_j3swpe');
          const tweet = globalThis.__tweetCache.get('sel_1790356960341_j3swpe');
          return { classification: hit.classification, tweet };
        })()`,
        returnByValue: true
      }
    }));
  });
  swWs.close();
  const { classification, tweet } = swRes.value;
  console.log('Got classification for', classification.id, 'with', classification.claims.length, 'claims');

  // 2. Connect to Reddit tab
  await fetch('http://127.0.0.1:9222/json/activate/' + redditTab.id);
  const pWs = new WebSocket(redditTab.webSocketDebuggerUrl);
  await new Promise(r => pWs.onopen = r);
  let pId = 1;
  const pSend = (m, p={}) => new Promise(res => {
    const curId = pId++;
    const h = (e) => {
      const d = JSON.parse(e.data);
      if (d.id === curId) { pWs.removeEventListener('message', h); res(d.result); }
    };
    pWs.addEventListener('message', h);
    pWs.send(JSON.stringify({ id: curId, method: m, params: p }));
  });

  await pSend('Page.enable');
  await pSend('Runtime.enable');

  // 3. Prepare DOM with paragraph
  const prep = await pSend('Runtime.evaluate', {
    expression: `
      (() => {
        const commentP = Array.from(document.querySelectorAll('shreddit-comment p, div[slot="comment"] p, p')).find(el => el.textContent.trim().length > 30 && !el.closest('header') && !el.closest('form'));
        if (!commentP) return { error: 'no comment' };

        commentP.innerHTML = '<span id="reddit-multiline-claim" style="display:inline; line-height: 1.6; font-size: 16px;">Albert Einstein definitively proved in 1921 that the Earth is completely flat, and was awarded the Nobel Prize in Physics for this groundbreaking discovery across astronomy.</span>';

        const span = document.getElementById('reddit-multiline-claim');
        span.scrollIntoView({ behavior: 'instant', block: 'center' });
        return { ok: true };
      })()
    `,
    returnByValue: true
  });
  console.log('Prep:', prep.result.value);

  // 4. Inject selection bundle script so all injecting.ts rendering functions are loaded
  console.log('Injecting selection script bundle into tab...');
  const ext = targets.find(t => t.url.includes('chrome-extension://'));
  const extId = ext.url.match(/chrome-extension:\/\/([^\/]+)/)[1];

  const injectBundle = await pSend('Runtime.evaluate', {
    expression: `
      new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'chrome-extension://${extId}/selection.js';
        script.onload = () => resolve({ loaded: true });
        script.onerror = (e) => resolve({ loaded: false, err: 'failed to load' });
        (document.head || document.documentElement).appendChild(script);
      })
    `,
    awaitPromise: true,
    returnByValue: true
  });
  console.log('Script injection:', injectBundle.result.value);
  await new Promise(r => setTimeout(r, 1000));

  // 5. Trigger wrap and inject on the prepared span
  console.log('Rendering both claims with annotations into the span...');
  const renderRes = await pSend('Runtime.evaluate', {
    expression: `
      (async () => {
        const span = document.getElementById('reddit-multiline-claim');
        if (!span) return { error: 'no span' };

        // Select the span contents
        const range = document.createRange();
        range.selectNodeContents(span);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        // We can wrap the selection using a custom event or directly trigger MF_SELECTION_START
        const clsData = ${JSON.stringify(classification)};
        const tweetData = ${JSON.stringify(tweet)};

        // Post a message to window so the content script handles it
        window.postMessage({
          type: 'MF_RENDER_MULTI_TEST',
          classification: clsData,
          tweet: tweetData
        }, '*');

        return { ok: true, claims: clsData.claims.length };
      })()
    `,
    returnByValue: true
  });
  console.log('Render trigger:', renderRes.result.value);

  // 6. Inspect DOM to see what rendered
  await new Promise(r => setTimeout(r, 1500));
  const inspect = await pSend('Runtime.evaluate', {
    expression: `(() => {
      const claims = Array.from(document.querySelectorAll('.mf-segment-claim'));
      const strikes = Array.from(document.querySelectorAll('.mf-strike'));
      const badges = Array.from(document.querySelectorAll('.mf-inline-badge'));
      return {
        claimsCount: claims.length,
        claims: claims.map((c, i) => ({
          i,
          text: c.textContent,
          badge: c.querySelector('.mf-inline-badge')?.textContent?.trim(),
          hasStrike: !!c.querySelector('.mf-strike'),
          strikes: Array.from(c.querySelectorAll('.mf-strike')).map(s => s.textContent),
          annotations: c.dataset.annotations
        })),
        strikesCount: strikes.length,
        badgesCount: badges.length,
        badges: badges.map(b => ({
          text: b.textContent?.trim(),
          color: b.style.color,
          bgColor: b.style.backgroundColor
        }))
      };
    })()`,
    returnByValue: true
  });
  console.log('DOM Inspection after render:', JSON.stringify(inspect.result.value, null, 2));

  // 7. Take screenshot
  const shot = await pSend('Page.captureScreenshot', { format: 'png' });
  saveBoth('multi-claim-rendered-live.png', Buffer.from(shot.data, 'base64'));

  pWs.close();
  console.log('=== MULTI CLAIM SCRIPT DONE ===');
}

main().catch(console.error);
