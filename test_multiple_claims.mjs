import fs from 'fs';

async function main() {
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const redditTab = targets.find(t => t.type === 'page' && t.url.includes('reddit.com'));
  const swTab = targets.find(t => t.type === 'service_worker' && t.url.includes('background.js'));
  if (!redditTab) throw new Error('No Reddit tab found');

  console.log('Connecting to SW and Reddit tab...');

  // 1. Connect to SW
  let swWs = null;
  if (swTab) {
    swWs = new WebSocket(swTab.webSocketDebuggerUrl);
    await new Promise(r => swWs.onopen = r);
    swWs.addEventListener('message', (e) => {
      const d = JSON.parse(e.data);
      if (d.method === 'Runtime.consoleAPICalled') {
        const args = d.params.args.map(a => a.value ?? a.description ?? JSON.stringify(a)).join(' ');
        console.log(`[SW] [${d.params.type}]`, args);
      }
    });
    swWs.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
  }

  // 2. Connect to Reddit tab
  const ws = new WebSocket(redditTab.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 2;
  const send = (m, p={}) => new Promise(res => {
    const cur = id++;
    const h = (e) => {
      const d = JSON.parse(e.data);
      if (d.id === cur) { ws.removeEventListener('message', h); res(d.result); }
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: cur, method: m, params: p }));
  });

  ws.addEventListener('message', (e) => {
    const d = JSON.parse(e.data);
    if (d.method === 'Runtime.consoleAPICalled') {
      const args = d.params.args.map(a => a.value ?? a.description ?? JSON.stringify(a)).join(' ');
      console.log(`[PAGE] [${d.params.type}]`, args);
    }
  });

  await send('Runtime.enable');
  await send('Page.enable');

  console.log('Finding and clicking Claim 1 Fact-Check badge...');
  const clickRes = await send('Runtime.evaluate', {
    expression: `(() => {
      const claims = Array.from(document.querySelectorAll('.mf-segment-claim'));
      if (claims.length < 2) return { error: 'Not enough claims', count: claims.length };
      const c1 = claims[1];
      const badge = c1.querySelector('.mf-inline-badge');
      if (!badge) return { error: 'No badge on claim 1' };
      badge.click();
      return { ok: true, badgeText: badge.textContent };
    })()`,
    returnByValue: true
  });
  console.log('Click result:', clickRes.result.value);

  console.log('Monitoring state for up to 60s...');
  const startTime = Date.now();
  let settled = false;

  while (Date.now() - startTime < 60000) {
    await new Promise(r => setTimeout(r, 2000));
    const check = await send('Runtime.evaluate', {
      expression: `(() => {
        const claims = Array.from(document.querySelectorAll('.mf-segment-claim'));
        const strikes = Array.from(document.querySelectorAll('.mf-strike'));
        return {
          claims: claims.map((c, i) => ({
            i,
            text: c.textContent?.slice(0, 50),
            badge: c.querySelector('.mf-inline-badge')?.textContent?.trim(),
            hasSpinner: !!c.querySelector('.mf-standalone-spinner') || !!c.querySelector('.mf-fc-spinner'),
            hasStrike: !!c.querySelector('.mf-strike'),
            strikeText: c.querySelector('.mf-strike')?.textContent,
            annotations: c.dataset.annotations
          })),
          strikesCount: strikes.length
        };
      })()`,
      returnByValue: true
    });

    const val = check.result.value;
    console.log(`[+${((Date.now() - startTime)/1000).toFixed(1)}s]`, JSON.stringify(val));

    // Check if claim 1 is no longer on hold / researching / spinner
    const c1 = val.claims?.[1];
    if (c1 && !c1.hasSpinner && c1.badge && c1.badge !== 'Fact-Check' && c1.badge !== 'Annotate' && !c1.badge.includes('Annotating')) {
      console.log('Claim 1 settled!');
      settled = true;
      break;
    }
  }

  // Capture final screenshot
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/Users/michaelpouget/.gemini/antigravity/brain/120409ed-dc7a-46bb-9dfb-cecf73c722ae/scratch/reddit-multi-claim-settled.png', Buffer.from(shot.data, 'base64'));
  console.log('Screenshot saved to scratch/reddit-multi-claim-settled.png');

  ws.close();
  if (swWs) swWs.close();
  process.exit(settled ? 0 : 1);
}

main().catch(console.error);
