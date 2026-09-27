// Reload the extension and wait for the new SW to activate
const list = await (await fetch("http://127.0.0.1:9222/json")).json();
const sw = list.find(t => t.url.includes("chrome-extension://") && t.type === "service_worker");
if (!sw) { console.log("No SW found"); process.exit(1); }

// Connect to extension SW to trigger reload
const ws = new WebSocket(sw.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });

// Execute chrome.runtime.reload()
ws.send(JSON.stringify({
  id: 1,
  method: "Runtime.evaluate",
  params: { expression: `chrome.runtime.reload()`, returnByValue: true }
}));

// Wait for it to take effect
await new Promise(r => setTimeout(r, 3000));

// Check new SW is up
const list2 = await (await fetch("http://127.0.0.1:9222/json")).json();
const sw2 = list2.find(t => t.url.includes("chrome-extension://") && t.type === "service_worker");
console.log("New SW:", sw2 ? "active" : "not found", sw2?.url);

ws.close();
process.exit(0);
