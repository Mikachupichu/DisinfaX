async function run() {
  console.log("Opening extension popup to connect to background SW...");
  const popupTab = await (await fetch("http://127.0.0.1:9222/json/new?chrome-extension://fooimbfbaakmembcajhcdhgjlfmecano/popup.html", { method: "PUT" })).json();
  const popWs = new WebSocket(popupTab.webSocketDebuggerUrl);
  await new Promise(r => popWs.onopen = r);

  let id = 1;
  const send = (m, p={}) => new Promise(res => {
    const cur = id++;
    const h = (e) => {
      const d = JSON.parse(e.data);
      if (d.id === cur) { popWs.removeEventListener("message", h); res(d.result); }
    };
    popWs.addEventListener("message", h);
    popWs.send(JSON.stringify({ id: cur, method: m, params: p }));
  });

  await send("Page.enable");
  await send("Runtime.enable");
  await new Promise(r => setTimeout(r, 1000));

  console.log("Sending RECLASSIFY_ON_HOLD_CLICK for Claim 1 from popup...");
  const triggerRes = await send("Runtime.evaluate", {
    expression: `(() => {
      const port = chrome.runtime.connect({ name: "classify" });
      const received = [];
      port.onMessage.addListener(msg => {
        received.push(msg);
      });
      port.postMessage({
        type: "RECLASSIFY_ON_HOLD_CLICK",
        data: {
          classificationId: "sel_1790356960341_j3swpe",
          claimText: "Albert Einstein was awarded the Nobel Prize in Physics in 1921 for proving that the Earth is completely flat.",
          locale: "en-US"
        }
      });
      window.__testPort = port;
      window.__receivedMessages = received;
      return { sent: true };
    })()`,
    returnByValue: true
  });
  console.log("Trigger from popup:", triggerRes.result.value);

  // Also connect to SW to monitor console logs
  const list = await (await fetch("http://127.0.0.1:9222/json")).json();
  const sw = list.find(t => t.url.includes("chrome-extension://") && t.type === "service_worker");
  let swWs = null;
  if (sw) {
    swWs = new WebSocket(sw.webSocketDebuggerUrl);
    await new Promise(r => swWs.onopen = r);
    swWs.addEventListener("message", (e) => {
      const d = JSON.parse(e.data);
      if (d.method === "Runtime.consoleAPICalled") {
        const args = d.params.args.map(a => a.value ?? a.description ?? JSON.stringify(a)).join(" ");
        console.log("[SW]", args);
      }
    });
    swWs.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
  }

  // Monitor for up to 50 seconds
  const start = Date.now();
  let done = false;
  while (Date.now() - start < 50000) {
    await new Promise(r => setTimeout(r, 2000));
    const check = await send("Runtime.evaluate", {
      expression: `(async () => {
        // Check received messages on port
        const msgs = window.__receivedMessages || [];
        const latestCls = msgs.filter(m => m.type === "CLASSIFICATION").pop()?.classification;
        return {
          msgCount: msgs.length,
          msgTypes: msgs.map(m => m.type),
          claims: latestCls?.claims?.map(c => ({
            text: c.text?.slice(0, 40),
            verdict: c.verdict,
            refreshing: c.refreshing,
            reclassifyOnHold: c.reclassifyOnHold,
            note: c.note?.slice(0, 50),
            annotations: c.annotations
          }))
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const val = check.result.value;
    console.log(`[+${((Date.now() - start)/1000).toFixed(1)}s] Status:`, JSON.stringify(val));
    const c1 = val.claims?.[1];
    if (c1 && !c1.refreshing && c1.verdict && c1.verdict !== "research required" && c1.note) {
      console.log(">>> CLAIM 1 SETTLED IN BROADCAST! <<<");
      if (c1.annotations && Object.keys(c1.annotations).length > 0) {
        console.log(">>> MULTI-CLAIM ANNOTATIONS VERIFIED! <<<");
        console.log("Claim 0 annotations:", JSON.stringify(val.claims[0].annotations));
        console.log("Claim 1 annotations:", JSON.stringify(c1.annotations));
        done = true;
        break;
      }
    }
  }

  // Close popup tab
  popWs.close();
  if (swWs) swWs.close();
  await fetch("http://127.0.0.1:9222/json/close/" + popupTab.id);
  process.exit(done ? 0 : 1);
}

run().catch(console.error);
