async function test() {
  const list = await (await fetch("http://127.0.0.1:9222/json")).json();
  const sw = list.find(t => t.url.includes("chrome-extension://") && t.type === "service_worker");
  if (!sw) throw new Error("No SW");

  const ws = new WebSocket(sw.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);

  ws.addEventListener("message", (e) => {
    const d = JSON.parse(e.data);
    if (d.method === "Runtime.consoleAPICalled") {
      const args = d.params.args.map(a => a.value ?? a.description ?? JSON.stringify(a)).join(" ");
      console.log(`[SW CONSOLE]`, args);
    }
  });

  await new Promise((res) => {
    ws.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
    setTimeout(res, 500);
  });

  console.log("Triggering RECLASSIFY_ON_HOLD_CLICK on Claim 1...");
  const evalRes = await new Promise((res) => {
    const id = 2;
    const h = (e) => {
      const d = JSON.parse(e.data);
      if (d.id === id) { ws.removeEventListener("message", h); res(d.result); }
    };
    ws.addEventListener("message", h);
    ws.send(JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: {
        expression: `(async () => {
          const cid = "sel_1790356960341_j3swpe";
          const claimText = "Albert Einstein was awarded the Nobel Prize in Physics in 1921 for proving that the Earth is completely flat.";
          const hit = globalThis.__classificationCache.get(cid);
          if (!hit) return { error: "not cached" };

          // Simulate port message: RECLASSIFY_ON_HOLD_CLICK
          // We can find the classify or relay port in activePorts, or post directly to the port listener
          // Or execute the handler logic directly
          const c1 = hit.classification.claims[1];
          return {
            cid,
            c1_before: {
              text: c1.text,
              verdict: c1.verdict,
              dbClaimId: c1.dbClaimId,
              annotations: c1.annotations
            }
          };
        })()`,
        awaitPromise: true,
        returnByValue: true
      }
    }));
  });
  console.log("Initial state:", JSON.stringify(evalRes.result.value, null, 2));

  // Now trigger RECLASSIFY_ON_HOLD_CLICK via chrome.runtime.connect
  console.log("Connecting runtime port to trigger RECLASSIFY_ON_HOLD_CLICK...");
  const triggerRes = await new Promise((res) => {
    const id = 3;
    const h = (e) => {
      const d = JSON.parse(e.data);
      if (d.id === id) { ws.removeEventListener("message", h); res(d.result); }
    };
    ws.addEventListener("message", h);
    ws.send(JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: {
        expression: `(async () => {
          const port = chrome.runtime.connect({ name: "classify" });
          port.postMessage({
            type: "RECLASSIFY_ON_HOLD_CLICK",
            data: {
              classificationId: "sel_1790356960341_j3swpe",
              claimText: "Albert Einstein was awarded the Nobel Prize in Physics in 1921 for proving that the Earth is completely flat.",
              locale: "en-US"
            }
          });
          return { sent: true };
        })()`,
        awaitPromise: true,
        returnByValue: true
      }
    }));
  });
  console.log("Trigger result:", triggerRes.result.value);

  // Monitor for 45 seconds
  const start = Date.now();
  while (Date.now() - start < 45000) {
    await new Promise(r => setTimeout(r, 2000));
    const check = await new Promise((res) => {
      const id = 100 + Math.floor(Math.random() * 1000);
      const h = (e) => {
        const d = JSON.parse(e.data);
        if (d.id === id) { ws.removeEventListener("message", h); res(d.result); }
      };
      ws.addEventListener("message", h);
      ws.send(JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: {
          expression: `(() => {
            const hit = globalThis.__classificationCache?.get("sel_1790356960341_j3swpe");
            if (!hit) return null;
            return hit.classification.claims.map(c => ({
              text: c.text?.slice(0, 40),
              verdict: c.verdict,
              refreshing: c.refreshing,
              reclassifyOnHold: c.reclassifyOnHold,
              note: c.note?.slice(0, 60),
              annotations: c.annotations
            }));
          })()`,
          returnByValue: true
        }
      }));
    });
    const claims = check?.result?.value;
    console.log(`[+${((Date.now() - start)/1000).toFixed(1)}s] Claims:`, JSON.stringify(claims));
    const c1 = claims?.[1];
    if (c1 && !c1.refreshing && c1.verdict && c1.verdict !== "research required" && c1.note) {
      console.log(">>> CLAIM 1 VERDICT SETTLED! <<<");
      if (c1.annotations && Object.keys(c1.annotations).length > 0) {
        console.log(">>> CLAIM 1 ANNOTATIONS LANDED! <<<", JSON.stringify(c1.annotations));
        break;
      }
    }
  }

  // Final check
  const finalCheck = await new Promise((res) => {
    const id = 999;
    const h = (e) => {
      const d = JSON.parse(e.data);
      if (d.id === id) { ws.removeEventListener("message", h); res(d.result); }
    };
    ws.addEventListener("message", h);
    ws.send(JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: {
        expression: `(() => {
          const hit = globalThis.__classificationCache?.get("sel_1790356960341_j3swpe");
          return hit?.classification;
        })()`,
        returnByValue: true
      }
    }));
  });
  console.log("FINAL FULL CLASSIFICATION:", JSON.stringify(finalCheck.result.value, null, 2));

  ws.close();
  process.exit(0);
}

test().catch(console.error);
