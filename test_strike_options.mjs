import fs from 'fs';

const ARTIFACT_DIR = '/Users/michaelpouget/.gemini/antigravity/brain/120409ed-dc7a-46bb-9dfb-cecf73c722ae';

async function testCss() {
  const list = await (await fetch("http://127.0.0.1:9222/json")).json();
  const redditTab = list.find(t => t.url.includes("reddit.com"));
  const ws = new WebSocket(redditTab.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);

  let msgId = 1;
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      const handler = (msg) => {
        const data = JSON.parse(msg.data);
        if (data.id === id) {
          ws.removeEventListener('message', handler);
          if (data.error) reject(data.error);
          else resolve(data.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // Inject a test container into reddit page
  await call("Runtime.evaluate", {
    expression: `(() => {
      let c = document.getElementById('test-strike-container');
      if (!c) {
        c = document.createElement('div');
        c.id = 'test-strike-container';
        c.style.cssText = 'position: fixed; top: 100px; left: 50px; width: 450px; background: white; padding: 20px; z-index: 999999; box-shadow: 0 4px 20px rgba(0,0,0,0.3); font-size: 18px; line-height: 1.8; font-family: -apple-system, sans-serif;';
        document.body.appendChild(c);
      }
      
      c.innerHTML = \`
        <h3>Test 1: Native line-through on display: inline</h3>
        <p>
          <span style="background-color: rgba(255, 0, 0, 0.45); padding: 2px 4px; border-radius: 3px;">
            Albert Einstein 
            <span style="display: inline; text-decoration: line-through; text-decoration-color: #f04438; text-decoration-thickness: 2.5px;">definitively proved in 1921 that the Earth is completely flat</span>
            <span style="color: #f04438; font-weight: bold; margin-left: 6px;">developed the theory of relativity</span>
          </span>
        </p>

        <h3>Test 2: SVG overlay or client rect lines</h3>
        <p id="test2-p">
          <span id="test2-claim" style="background-color: rgba(255, 0, 0, 0.45); padding: 2px 4px; border-radius: 3px; position: relative;">
            Albert Einstein 
            <span id="test2-strike" style="display: inline; position: relative;">definitively proved in 1921 that the Earth is completely flat</span>
            <span style="color: #f04438; font-weight: bold; margin-left: 6px;">developed the theory of relativity</span>
          </span>
        </p>
      \`;

      // For Test 2: generate SVG / lines based on getClientRects()!
      const strikeEl = document.getElementById('test2-strike');
      const rects = strikeEl.getClientRects();
      const claimRect = document.getElementById('test2-claim').getBoundingClientRect();
      const parentRect = strikeEl.offsetParent ? strikeEl.offsetParent.getBoundingClientRect() : claimRect;

      // Add SVG overlay inside test2-claim
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible;';
      
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        const x1 = r.left - claimRect.left;
        const x2 = r.right - claimRect.left;
        const y = r.top - claimRect.top + r.height / 2;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', x1);
        line.setAttribute('y1', y);
        line.setAttribute('x2', x2);
        line.setAttribute('y2', y);
        line.setAttribute('stroke', '#f04438');
        line.setAttribute('stroke-width', '2.5');
        line.setAttribute('stroke-linecap', 'round');
        svg.appendChild(line);
      }
      document.getElementById('test2-claim').appendChild(svg);

      return {
        rectsCount: rects.length
      };
    })()`,
    returnByValue: true
  });

  await new Promise(r => setTimeout(r, 500));

  // Screenshot container
  const boxRes = await call("Runtime.evaluate", {
    expression: `(() => {
      const c = document.getElementById('test-strike-container');
      const r = c.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`,
    returnByValue: true
  });
  const box = boxRes.result.value;

  const snap = await call("Page.captureScreenshot", {
    clip: {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      scale: 2
    }
  });

  fs.writeFileSync(ARTIFACT_DIR + '/test-strikes-comparison.png', Buffer.from(snap.data, 'base64'));
  console.log("Saved test-strikes-comparison.png");

  ws.close();
}
testCss();
