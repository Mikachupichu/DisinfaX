const list = await (await fetch("http://127.0.0.1:9222/json")).json();
const xTab = list.find(t => t.url.includes("x.com"));
const ws = new WebSocket(xTab.webSocketDebuggerUrl);
ws.onopen = () => {
  ws.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: {
      expression: `(() => {
        return {
          url: location.href,
          articles: document.querySelectorAll('article[data-testid="tweet"]').length,
          texts: Array.from(document.querySelectorAll('[data-testid="tweetText"]')).map(e => e.textContent?.slice(0, 80))
        };
      })()`,
      returnByValue: true
    }
  }));
};
ws.onmessage = (msg) => {
  const res = JSON.parse(msg.data);
  if (res.id === 1) {
    console.log("X status:", JSON.stringify(res.result.result.value, null, 2));
    ws.close();
    process.exit(0);
  }
};
