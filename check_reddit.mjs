const list = await (await fetch("http://127.0.0.1:9222/json")).json();
const redditTab = list.find(t => t.url.includes("reddit.com"));
if (!redditTab) {
  console.log("No Reddit tab found");
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
        const badges = Array.from(document.querySelectorAll('.mf-inline-badge'));
        const strikes = Array.from(document.querySelectorAll('.mf-strike'));
        return {
          url: location.href,
          claimsCount: claims.length,
          claims: claims.map(c => ({
            text: c.textContent?.slice(0, 80),
            dataset: { ...c.dataset },
            badge: c.querySelector('.mf-inline-badge')?.textContent?.trim(),
            hasStrike: !!c.querySelector('.mf-strike'),
            strikeText: c.querySelector('.mf-strike')?.textContent
          })),
          badgesCount: badges.length,
          badges: badges.map(b => ({
            text: b.textContent?.trim(),
            className: b.className,
            color: b.style.color,
            bgColor: b.style.backgroundColor
          })),
          strikesCount: strikes.length
        };
      })()`,
      returnByValue: true
    }
  }));
};
ws.onmessage = (msg) => {
  const res = JSON.parse(msg.data);
  if (res.id === 1) {
    console.log("Reddit status:", JSON.stringify(res.result.result.value, null, 2));
    ws.close();
    process.exit(0);
  }
};
