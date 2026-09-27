import fs from 'fs';

const ARTIFACT_DIR = '/Users/michaelpouget/.gemini/antigravity/brain/120409ed-dc7a-46bb-9dfb-cecf73c722ae';

async function testSolution() {
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

  // Remove old test container if any
  await call("Runtime.evaluate", {
    expression: `(() => {
      document.getElementById('test-strike-container')?.remove();
      const post = document.querySelector('shreddit-post');
      const titleA = post?.querySelector('[slot="title"]') || post?.querySelector('a[id*="post-title"]');
      if (!titleA) return { error: 'no titleA' };

      titleA.style.lineHeight = '1.8';
      titleA.style.fontSize = '18px';
      titleA.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      titleA.style.display = 'block';

      // Solution:
      // The claim span is display: inline, with background-color.
      // The struck text is display: inline (NEVER inline-block!).
      // For each line of the struck text, we render SVG lines with stroke-linecap: round!
      titleA.innerHTML = \`
        <span class="mf-segment-wrap" style="-webkit-box-decoration-break: slice; box-decoration-break: slice; border-radius: 3px; padding: 1px 0px;">
          <span id="claim0" class="mf-segment-claim" style="background-color: rgba(255, 0, 0, 0.45); -webkit-box-decoration-break: slice; box-decoration-break: slice; border-top-left-radius: 3px; border-bottom-left-radius: 3px; border-top-right-radius: 999px; border-bottom-right-radius: 999px; padding: 1px 3px; position: relative;">
            Albert Einstein <span id="strike0" class="mf-strike" style="display: inline; position: relative;">definitively proved in 1921 that the Earth is completely flat</span> <span class="mf-correction" style="color: rgb(244, 33, 46); font-weight: bold; margin: 0 4px;">developed the theory of general relativity</span><span class="mf-badge-cap" style="display: inline-flex; align-items: center; vertical-align: middle; padding: 0 2px 0 0; position: relative; top: 0;"><span class="mf-inline-badge mf-verdict-badge" style="display: inline-block; position: relative; top: -0.142em; line-height: 1.15; padding: 0.12em 0.52em; border-radius: 999px; background-color: rgba(0, 0, 0, 0.7); color: rgb(255, 255, 255); font-size: 0.75em; font-weight: 600; margin-left: 0.22em; white-space: nowrap; user-select: none;">100% False</span></span>
          </span>, and <span id="claim1" class="mf-segment-claim" style="background-color: rgba(255, 0, 0, 0.45); -webkit-box-decoration-break: slice; box-decoration-break: slice; border-top-left-radius: 3px; border-bottom-left-radius: 3px; border-top-right-radius: 999px; border-bottom-right-radius: 999px; padding: 1px 3px; position: relative;">
            was awarded the Nobel Prize in Physics in 1921 <span id="strike1" class="mf-strike" style="display: inline; position: relative;">for proving that the Earth is completely flat</span> <span class="mf-correction" style="color: rgb(244, 33, 46); font-weight: bold; margin: 0 4px;">for his discovery of the law of the photoelectric effect</span><span class="mf-badge-cap" style="display: inline-flex; align-items: center; vertical-align: middle; padding: 0 2px 0 0; position: relative; top: 0;"><span class="mf-inline-badge mf-verdict-badge" style="display: inline-block; position: relative; top: -0.142em; line-height: 1.15; padding: 0.12em 0.52em; border-radius: 999px; background-color: rgba(0, 0, 0, 0.7); color: rgb(255, 255, 255); font-size: 0.75em; font-weight: 600; margin-left: 0.22em; white-space: nowrap; user-select: none;">100% False</span></span>
          </span> across astronomy.
        </span>
      \`;

      function renderStrikeSvg(containerEl, strikeEl) {
        const rects = strikeEl.getClientRects();
        const containerRect = containerEl.getBoundingClientRect();
        let svg = containerEl.querySelector('svg.mf-strike-svg');
        if (!svg) {
          svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.className = 'mf-strike-svg';
          svg.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; z-index: 10;';
          containerEl.appendChild(svg);
        }
        
        for (let i = 0; i < rects.length; i++) {
          const r = rects[i];
          if (r.width <= 0 || r.height <= 0) continue;
          const x1 = r.left - containerRect.left;
          const x2 = r.right - containerRect.left;
          // Exact text line vertical center
          const y = r.top - containerRect.top + (r.height / 2);
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
      }

      titleA.style.position = 'relative';
      renderStrikeSvg(titleA, document.getElementById('strike0'));
      renderStrikeSvg(titleA, document.getElementById('strike1'));

      return { ok: true };
    })()`,
    returnByValue: true
  });

  await new Promise(r => setTimeout(r, 600));

  // Screenshot title
  const boxRes = await call("Runtime.evaluate", {
    expression: `(() => {
      const wraps = Array.from(document.querySelectorAll('.mf-segment-wrap'));
      const wrap = wraps.find(el => el.getBoundingClientRect().width > 0) || wraps[0];
      wrap.scrollIntoView({ behavior: 'instant', block: 'center' });
      const r = wrap.getBoundingClientRect();
      return { x: Math.max(0, r.x - 20), y: Math.max(0, r.y - 20), width: r.width + 40, height: r.height + 40 };
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

  fs.writeFileSync(ARTIFACT_DIR + '/test-solution-rendered.png', Buffer.from(snap.data, 'base64'));
  console.log("Saved test-solution-rendered.png");

  ws.close();
}
testSolution();
