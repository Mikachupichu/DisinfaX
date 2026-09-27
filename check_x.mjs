// Check the current state of the X tab (no reload)
const list = await (await fetch("http://127.0.0.1:9222/json")).json();
const xTab = list.find(t => t.url.includes("x.com"));
if (!xTab) { console.log("No X tab"); process.exit(1); }

const ws = new WebSocket(xTab.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });

let msgId = 1;
const send = (m, p = {}) => new Promise(res => {
  const id = msgId++;
  const h = (e) => {
    const d = JSON.parse(e.data);
    if (d.id === id) { ws.removeEventListener('message', h); res(d.result); }
  };
  ws.addEventListener('message', h);
  ws.send(JSON.stringify({ id, method: m, params: p }));
});

const res = await send("Runtime.evaluate", {
  expression: `(() => {
    return Array.from(document.querySelectorAll('article[data-testid="tweet"]')).slice(0, 8).map((a, i) => ({
      i,
      text: a.querySelector('[data-testid="tweetText"]')?.textContent?.slice(0, 80),
      btn: a.querySelector('.mf-topbtn-label')?.textContent?.trim(),
      claims: Array.from(a.querySelectorAll('.mf-segment-claim')).length,
      badges: Array.from(a.querySelectorAll('.mf-inline-badge')).map(b => b.textContent?.trim())
    }));
  })()`,
  returnByValue: true
});
console.log("Current tweets:", JSON.stringify(res.result.value, null, 2));

ws.close();
process.exit(0);
