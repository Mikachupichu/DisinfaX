const list = await (await fetch("http://127.0.0.1:9222/json")).json();
const sw = list.find(t => t.url.includes("chrome-extension://") && t.type === "service_worker");
if (!sw) {
  console.log("No SW found");
  process.exit(1);
}
const ws = new WebSocket(sw.webSocketDebuggerUrl);
ws.onopen = () => {
  ws.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: {
      expression: `(() => {
        const clsMap = (globalThis).__classificationCache;
        const tweetMap = (globalThis).__tweetCache;
        return {
          clsKeys: clsMap ? Array.from(clsMap.keys()) : [],
          clsEntries: clsMap ? Array.from(clsMap.entries()).map(([k, v]) => ({
            id: k,
            claims: v.classification?.claims?.map(c => ({
              text: c.text?.slice(0, 60),
              confidence: c.confidence,
              veracity: c.veracity,
              note: c.note?.slice(0, 40),
              reclassifyOnHold: c.reclassifyOnHold,
              dbClaimId: c.dbClaimId,
              annotations: c.annotations
            }))
          })) : [],
          tweetKeys: tweetMap ? Array.from(tweetMap.keys()) : []
        };
      })()`,
      returnByValue: true
    }
  }));
};
ws.onmessage = (msg) => {
  const res = JSON.parse(msg.data);
  if (res.id === 1) {
    console.log("SW Caches:", JSON.stringify(res.result.result.value, null, 2));
    ws.close();
    process.exit(0);
  }
};
