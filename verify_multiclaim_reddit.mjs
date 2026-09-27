import fs from 'fs';

const ARTIFACT_DIR = '/Users/michaelpouget/.gemini/antigravity/brain/120409ed-dc7a-46bb-9dfb-cecf73c722ae';
const SCRATCH_DIR = ARTIFACT_DIR + '/scratch';

function saveBoth(name, buf) {
  fs.writeFileSync(ARTIFACT_DIR + '/' + name, buf);
  fs.writeFileSync(SCRATCH_DIR + '/' + name, buf);
  console.log('Saved:', name, '(' + buf.length + ' bytes)');
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('=== MULTI-CLAIM ANNOTATIONS VERIFICATION ===');
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const pageTab = targets.find(t => t.type === 'page' && t.url.includes('reddit.com'));
  if (!pageTab) throw new Error('No Reddit tab found');

  // Activate tab
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

  pWs.addEventListener('message', (e) => {
    const d = JSON.parse(e.data);
    if (d.method === 'Runtime.consoleAPICalled') {
      const args = d.params.args.map(a => a.value ?? a.description ?? JSON.stringify(a)).join(' ');
      console.log(`[PAGE] [${d.params.type}]`, args);
    }
  });

  await pSend('Page.enable');
  await pSend('Runtime.enable');

  console.log('1. Reloading Reddit page for fresh extension context...');
  await pSend('Page.reload', { ignoreCache: true });
  await sleep(6000);

  console.log('2. Inserting test multi-claim text...');
  const prep = await pSend('Runtime.evaluate', {
    expression: `
      (() => {
        const commentP = Array.from(document.querySelectorAll('shreddit-comment p, div[slot="comment"] p, p')).find(el => el.textContent.trim().length > 30 && !el.closest('header') && !el.closest('form'));
        if (!commentP) return { error: 'no comment paragraph found' };

        commentP.innerHTML = '<span id="reddit-multiline-claim" style="display:inline; line-height: 1.6; font-size: 16px;">Albert Einstein definitively proved in 1921 that the Earth is completely flat, and was awarded the Nobel Prize in Physics for this groundbreaking discovery across astronomy.</span>';

        const span = document.getElementById('reddit-multiline-claim');
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
  console.log('Selection prepared:', prep.result.value);

  console.log('3. Triggering selection pipeline via popup...');
  const popupTab = await (await fetch('http://127.0.0.1:9222/json/new', { method: 'PUT' })).json();
  const popWs = new WebSocket(popupTab.webSocketDebuggerUrl);
  await new Promise(r => popWs.onopen = r);
  let popId = 1;
  const popSend = (m, p={}) => new Promise(res => {
    const id = popId++;
    const h = (e) => {
      const d = JSON.parse(e.data);
      if (d.id === id) { popWs.removeEventListener('message', h); res(d.result); }
    };
    popWs.addEventListener('message', h);
    popWs.send(JSON.stringify({ id, method: m, params: p }));
  });
  await popSend('Page.enable');
  await popSend('Runtime.enable');
  await popSend('Page.navigate', { url: 'chrome-extension://fooimbfbaakmembcajhcdhgjlfmecano/popup.html' });
  await sleep(1500);

  const triggerRes = await popSend('Runtime.evaluate', {
    expression: `
      (async () => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(t => t.url && t.url.includes('reddit.com'));
        if (!tab) return { error: 'no-tab' };
        const res = await chrome.runtime.sendMessage({
          type: 'MF_SELECTION_START_TAB',
          tabId: tab.id
        });
        return { ok: true, tabId: tab.id, res };
      })()
    `,
    awaitPromise: true,
    returnByValue: true
  });
  console.log('Trigger res:', triggerRes.result.value);
  await popSend('Page.close');
  popWs.close();
  await fetch('http://127.0.0.1:9222/json/close/' + popupTab.id);

  console.log('4. Waiting for claims to appear (up to 20s)...');
  let claimsCount = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const check = await pSend('Runtime.evaluate', {
      expression: `(() => {
        const claims = Array.from(document.querySelectorAll('.mf-segment-claim'));
        return {
          count: claims.length,
          claims: claims.map(c => ({
            text: c.textContent?.slice(0, 40),
            badge: c.querySelector('.mf-inline-badge')?.textContent?.trim()
          }))
        };
      })()`,
      returnByValue: true
    });
    if (check.result?.value?.count > 0) {
      claimsCount = check.result.value.count;
      console.log(`Claims appeared (${claimsCount}):`, JSON.stringify(check.result.value.claims));
      break;
    }
  }

  if (claimsCount === 0) {
    throw new Error('No claims appeared within 20s');
  }

  console.log('5. Handling Claim 0: if Fact-Check is present, clicking it...');
  const c0Check = await pSend('Runtime.evaluate', {
    expression: `(() => {
      const claims = Array.from(document.querySelectorAll('.mf-segment-claim'));
      const b0 = claims[0]?.querySelector('.mf-inline-badge');
      if (b0 && b0.textContent.includes('Fact-Check')) {
        b0.click();
        return { clicked: true, text: b0.textContent };
      }
      return { clicked: false, text: b0?.textContent };
    })()`,
    returnByValue: true
  });
  console.log('Claim 0 initial state:', c0Check.result.value);

  console.log('Waiting for Claim 0 to settle (verdict + annotations)...');
  for (let i = 0; i < 50; i++) {
    await sleep(1000);
    const state = await pSend('Runtime.evaluate', {
      expression: `(() => {
        const claims = Array.from(document.querySelectorAll('.mf-segment-claim'));
        const c0 = claims[0];
        if (!c0) return null;
        const b0 = c0.querySelector('.mf-inline-badge');
        const badgeText = b0 ? b0.textContent.trim() : '';
        const isVerdict = !!c0.querySelector('.mf-verdict-badge');
        const hasStrike = !!c0.querySelector('.mf-strike');
        const annotations = c0.dataset.annotations;
        return {
          badgeText,
          isVerdict,
          hasStrike,
          strikeText: c0.querySelector('.mf-strike')?.textContent,
          annotations
        };
      })()`,
      returnByValue: true
    });
    const s = state.result?.value;
    if (s?.isVerdict && !s.badgeText.includes('Fact-Check') && !s.badgeText.includes('Annotating')) {
      console.log(`Claim 0 settled at ${i}s:`, JSON.stringify(s));
      break;
    }
    if (i % 5 === 0) console.log(`Claim 0 waiting... (${i}s) badge="${s?.badgeText}" hasStrike=${s?.hasStrike}`);
  }

  console.log('6. Now checking Claim 1 state...');
  const c1State = await pSend('Runtime.evaluate', {
    expression: `(() => {
      const claims = Array.from(document.querySelectorAll('.mf-segment-claim'));
      const c1 = claims[1];
      if (!c1) return { error: 'no c1' };
      const b1 = c1.querySelector('.mf-inline-badge');
      return {
        badgeText: b1?.textContent?.trim(),
        hasStrike: !!c1.querySelector('.mf-strike'),
        annotations: c1.dataset.annotations
      };
    })()`,
    returnByValue: true
  });
  console.log('Claim 1 state before clicking Fact-Check:', JSON.stringify(c1State.result.value));

  console.log('7. Clicking Fact-Check on Claim 1 to test MULTI-CLAIM ANNOTATIONS...');
  const c1Click = await pSend('Runtime.evaluate', {
    expression: `(() => {
      const claims = Array.from(document.querySelectorAll('.mf-segment-claim'));
      const c1 = claims[1];
      const b1 = c1?.querySelector('.mf-inline-badge');
      if (b1) {
        b1.click();
        return { ok: true, text: b1.textContent };
      }
      return { error: 'no badge on c1' };
    })()`,
    returnByValue: true
  });
  console.log('Claim 1 click result:', c1Click.result.value);

  console.log('8. Monitoring Claim 1 research and Flow A annotation run...');
  let c1Settled = false;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const multiState = await pSend('Runtime.evaluate', {
      expression: `(() => {
        const claims = Array.from(document.querySelectorAll('.mf-segment-claim'));
        const strikes = Array.from(document.querySelectorAll('.mf-strike'));
        return {
          claims: claims.map((c, idx) => ({
            idx,
            badge: c.querySelector('.mf-inline-badge')?.textContent?.trim(),
            isVerdict: !!c.querySelector('.mf-verdict-badge'),
            hasStrike: !!c.querySelector('.mf-strike'),
            strikeText: c.querySelector('.mf-strike')?.textContent,
            correction: c.querySelector('.mf-correction')?.textContent,
            annotations: c.dataset.annotations
          })),
          totalStrikes: strikes.length
        };
      })()`,
      returnByValue: true
    });

    const ms = multiState.result?.value;
    const c1 = ms?.claims?.[1];
    if (i % 3 === 0 || (c1 && !c1.badge?.includes('researchingWords') && !c1.badge?.includes('Annotating'))) {
      console.log(`[+${i}s] Claims status:`, JSON.stringify(ms));
    }

    if (c1 && c1.isVerdict && !c1.badge?.includes('Fact-Check') && !c1.badge?.includes('Annotating')) {
      console.log(`>>> CLAIM 1 SETTLED WITH VERDICT! <<<`);
      c1Settled = true;
      break;
    }
  }

  // Clear any selection for clean rendering
  await pSend('Runtime.evaluate', { expression: `window.getSelection().removeAllRanges()` });
  await sleep(1000);

  // Take final screenshots
  console.log('9. Capturing final screenshots of multi-claim annotations...');
  const shot = await pSend('Page.captureScreenshot', { format: 'png' });
  saveBoth('multi-claim-reddit-settled.png', Buffer.from(shot.data, 'base64'));

  // Detailed inspect of both claims in DOM
  const finalInspect = await pSend('Runtime.evaluate', {
    expression: `(() => {
      const claims = Array.from(document.querySelectorAll('.mf-segment-claim'));
      return claims.map((c, i) => ({
        i,
        text: c.textContent,
        innerHTML: c.innerHTML,
        dataset: { ...c.dataset },
        badgeText: c.querySelector('.mf-inline-badge')?.textContent?.trim(),
        badgeColor: c.querySelector('.mf-inline-badge')?.style.color,
        hasStrike: !!c.querySelector('.mf-strike'),
        strikeCount: c.querySelectorAll('.mf-strike').length,
        corrections: Array.from(c.querySelectorAll('.mf-correction, [class*="correction"]')).map(el => el.textContent)
      }));
    })()`,
    returnByValue: true
  });
  console.log('Final DOM Inspection:', JSON.stringify(finalInspect.result.value, null, 2));

  pWs.close();
  console.log('=== VERIFICATION SCRIPT COMPLETE ===');
}

main().catch(console.error);
