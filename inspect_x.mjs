const list = await (await fetch("http://127.0.0.1:9222/json")).json();
const xTab = list.find(t => t.url.includes("x.com"));
const ws = new WebSocket(xTab.webSocketDebuggerUrl);
ws.onopen = () => {
  ws.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: {
      expression: `(() => {
        const c = document.querySelector('.mf-btn-container');
        return {
          innerHTML: c?.innerHTML,
          buttons: Array.from(c?.querySelectorAll('button') ?? []).map(b => ({
            charge: b.dataset.mfCharge,
            text: b.textContent.trim(),
            title: b.title
          }))
        };
      })()`,
      returnByValue: true
    }
  }));
};
ws.onmessage = (msg) => {
  const res = JSON.parse(msg.data);
  if (res.id === 1) {
    console.log("X Container:", JSON.stringify(res.result.result.value, null, 2));
    ws.close();
    process.exit(0);
  }
};
