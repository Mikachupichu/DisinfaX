const list = await (await fetch("http://127.0.0.1:9222/json")).json();
const xTab = list.find(t => t.url.includes("x.com"));
const ws = new WebSocket(xTab.webSocketDebuggerUrl);
ws.onopen = () => {
  ws.send(JSON.stringify({ id: 1, method: "Page.reload", params: { ignoreCache: true } }));
};
ws.onmessage = (msg) => {
  const res = JSON.parse(msg.data);
  if (res.id === 1) {
    console.log("X Tab reload triggered");
    ws.close();
    process.exit(0);
  }
};
