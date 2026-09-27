import fs from 'fs';

const ARTIFACT_DIR = '/Users/michaelpouget/.gemini/antigravity/brain/120409ed-dc7a-46bb-9dfb-cecf73c722ae';
const SCRATCH_DIR = ARTIFACT_DIR + '/scratch';

function saveBoth(name, buf) {
  fs.writeFileSync(ARTIFACT_DIR + '/' + name, buf);
  fs.writeFileSync(SCRATCH_DIR + '/' + name, buf);
  console.log('Saved:', name, '(' + buf.length + ' bytes)');
}

async function main() {
  console.log('=== MULTI-CLAIM VERIFICATION ON X ===');
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const pageTab = targets.find(t => t.type === 'page' && t.url.includes('x.com'));
  if (!pageTab) throw new Error('No X tab found');

  await fetch('http://127.0.0.1:9222/json/activate/' + pageTab.id);

  const pWs = new WebSocket(pageTab.webSocketDebuggerUrl);
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

  console.log('1. Setting up multi-claim passage on X tweetText...');
  const prep = await pSend('Runtime.evaluate', {
    expression: `
      (() => {
        const tweetText = Array.from(document.querySelectorAll('article[data-testid="tweet"] div[data-testid="tweetText"]')).find(el => el.textContent.trim().length > 15);
        if (!tweetText) return { error: 'no tweetText found' };

        tweetText.innerHTML = '<span id="x-multiline-claim" style="display:inline; line-height: 1.5; font-size: 15px;">Albert Einstein definitively proved in 1921 that the Earth is completely flat, and was awarded the Nobel Prize in Physics for this groundbreaking discovery across astronomy.</span>';

        const span = document.getElementById('x-multiline-claim');
        span.scrollIntoView({ behavior: 'instant', block: 'center' });

        const range = document.createRange();
        range.selectNodeContents(span);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        return {
          ok: true,
          text: sel.toString()
        };
      })()
    `,
    returnByValue: true
  });
  console.log('X selection prep:', prep.result.value);

  console.log('2. Triggering selection pipeline via extension popup on X...');
  const popupTab = await (await fetch('http://127.0.0.1:9222/json/new?chrome-extension://fooimbfbaakmembcajhcdhgjlfmecano/popup.html', { method: 'PUT' })).json();
  const popWs = new WebSocket(popupTab.webSocketDebuggerUrl);
  await new Promise(r => popWs.onopen = r);
  let popId = 1;
  const popSend = (m, p={}) => new Promise(res => {
    const curId = popId++;
    const h = (e) => {
      const d = JSON.parse(e.data);
      if (d.id === curId) { popWs.removeEventListener('message', h); res(d.result); }
    };
    popWs.addEventListener('message', h);
    popWs.send(JSON.stringify({ id: curId, method: m, params: p }));
  });

  await popSend('Page.enable');
  await popSend('Runtime.enable');
  await new Promise(r => setTimeout(r, 1200));

  const trigRes = await popSend('Runtime.evaluate', {
    expression: `
      (async () => {
        const tabs = await chrome.tabs.query({});
        const targetTab = tabs.find(t => t.url && t.url.includes('x.com'));
        if (!targetTab) return { error: 'no-x-tab' };
        return await chrome.runtime.sendMessage({
          type: 'MF_SELECTION_START_TAB',
          tabId: targetTab.id
        });
      })()
    `,
    awaitPromise: true,
    returnByValue: true
  });
  console.log('Popup trigger result on X:', trigRes.result.value);
  popWs.close();
  await fetch('http://127.0.0.1:9222/json/close/' + popupTab.id);

  console.log('3. Waiting for claims to render on X...');
  let claimsRendered = false;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500));
    const check = await pSend('Runtime.evaluate', {
      expression: `
        (() => {
          const claims = Array.from(document.querySelectorAll('.mf-segment-claim'));
          const strikes = Array.from(document.querySelectorAll('.mf-strike'));
          return {
            count: claims.length,
            strikesCount: strikes.length,
            claims: claims.map(c => ({
              text: c.textContent?.slice(0, 40),
              badge: c.querySelector('.mf-inline-badge')?.textContent?.trim(),
              hasStrike: !!c.querySelector('.mf-strike')
            }))
          };
        })()
      `,
      returnByValue: true
    });
    const val = check.result.value;
    if (val.count >= 2) {
      console.log('Claims rendered on X:', JSON.stringify(val));
      claimsRendered = true;
      break;
    }
  }

  if (!claimsRendered) throw new Error('Claims failed to render');

  console.log('4. Checking if Claim 1 has Fact-Check button and clicking it...');
  const c1Action = await pSend('Runtime.evaluate', {
    expression: `
      (() => {
        const claims = Array.from(document.querySelectorAll('.mf-segment-claim'));
        if (claims.length < 2) return { error: 'not enough claims' };
        const c1 = claims[1];
        const badge = c1.querySelector('.mf-inline-badge');
        if (badge && badge.textContent.includes('Fact-Check')) {
          badge.click();
          return { clicked: true, text: badge.textContent };
        }
        return { clicked: false, badgeText: badge?.textContent };
      })()
    `,
    returnByValue: true
  });
  console.log('Claim 1 button action:', c1Action.result.value);

  console.log('5. Monitoring Claim 1 research and Flow A annotations run...');
  let c1Settled = false;
  for (let i = 0; i < 45; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const check = await pSend('Runtime.evaluate', {
      expression: `
        (() => {
          const claims = Array.from(document.querySelectorAll('.mf-segment-claim'));
          const strikes = Array.from(document.querySelectorAll('.mf-strike'));
          return {
            count: claims.length,
            strikesCount: strikes.length,
            claims: claims.map(c => ({
              badge: c.querySelector('.mf-inline-badge')?.textContent?.trim(),
              isVerdict: !!c.querySelector('.mf-verdict-badge'),
              hasStrike: !!c.querySelector('.mf-strike'),
              strikeText: c.querySelector('.mf-strike')?.textContent,
              correction: c.querySelector('.mf-correction')?.textContent,
              annotations: c.dataset.annotations
            }))
          };
        })()
      `,
      returnByValue: true
    });
    const val = check.result.value;
    const c1 = val.claims?.[1];
    if (i % 3 === 0 || (c1 && c1.isVerdict)) {
      console.log(`[+${i}s] Claims status:`, JSON.stringify(val));
    }
    if (c1 && c1.isVerdict && !c1.badge?.includes('Fact-Check') && !c1.badge?.includes('Annotating')) {
      console.log('>>> BOTH CLAIMS FULLY SETTLED ON X! <<<');
      c1Settled = true;
      break;
    }
  }

  // Clear selection
  await pSend('Runtime.evaluate', { expression: 'window.getSelection().removeAllRanges()' });
  await new Promise(r => setTimeout(r, 800));

  // Capture full screenshot
  console.log('6. Capturing screenshots...');
  const shot = await pSend('Page.captureScreenshot', { format: 'png' });
  saveBoth('x-multi-claim-settled.png', Buffer.from(shot.data, 'base64'));

  // Detailed inspect of both claims
  const inspect = await pSend('Runtime.evaluate', {
    expression: `
      (() => {
        const claims = Array.from(document.querySelectorAll('.mf-segment-claim'));
        const badges = Array.from(document.querySelectorAll('.mf-inline-badge'));
        const strikes = Array.from(document.querySelectorAll('.mf-strike'));
        return {
          claimsCount: claims.length,
          claims: claims.map((c, i) => ({
            i,
            text: c.textContent,
            badge: c.querySelector('.mf-inline-badge')?.textContent?.trim(),
            badgeColor: window.getComputedStyle(c.querySelector('.mf-inline-badge')).color,
            badgeBg: window.getComputedStyle(c.querySelector('.mf-inline-badge')).backgroundColor,
            badgeTop: window.getComputedStyle(c.querySelector('.mf-inline-badge')).top,
            hasStrike: !!c.querySelector('.mf-strike'),
            strikeText: c.querySelector('.mf-strike')?.textContent,
            strikeColor: window.getComputedStyle(c.querySelector('.mf-strike-line') || c.querySelector('.mf-strike')).backgroundColor,
            annotations: c.dataset.annotations
          })),
          strikesCount: strikes.length,
          badgesCount: badges.length
        };
      })()
    `,
    returnByValue: true
  });
  console.log('Final Inspection on X:', JSON.stringify(inspect.result.value, null, 2));

  pWs.close();
  console.log('=== MULTI-CLAIM VERIFICATION ON X COMPLETE ===');
}

main().catch(console.error);
