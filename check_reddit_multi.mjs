const list = await (await fetch("http://127.0.0.1:9222/json")).json();
const redditTab = list.find(t => t.url.includes("reddit.com"));
if (!redditTab) {
  console.log("No Reddit tab");
  process.exit(1);
}

const ws = new WebSocket(redditTab.webSocketDebuggerUrl);
ws.onopen = () => {
  ws.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: {
      expression: `(() => {
        const claims = Array.from(document.querySelectorAll('.mf-segment-claim'));
        const strikes = Array.from(document.querySelectorAll('.mf-strike'));
        const badges = Array.from(document.querySelectorAll('.mf-inline-badge'));
        return {
          claimsCount: claims.length,
          claims: claims.map((c, i) => ({
            i,
            text: c.textContent?.slice(0, 70),
            badge: c.querySelector('.mf-inline-badge')?.textContent?.trim(),
            hasStrike: !!c.querySelector('.mf-strike'),
            strikeText: c.querySelector('.mf-strike')?.textContent,
            annotations: c.dataset.annotations
          })),
          strikesCount: strikes.length,
          strikes: strikes.map(s => s.textContent),
          badges: badges.map(b => b.textContent?.trim())
        };
      })()`,
      returnByValue: true
    }
  }));
};
ws.onmessage = (msg) => {
  const res = JSON.parse(msg.data);
  if (res.id === 1) {
    console.log("Reddit DOM rendering:", JSON.stringify(res.result.result.value, null, 2));
    ws.close();
    process.exit(0);
  }
};
