import urllib.request, json, asyncio, websockets, base64, time, os

ARTIFACT_DIR = '/Users/michaelpouget/.gemini/antigravity/brain/120409ed-dc7a-46bb-9dfb-cecf73c722ae'
SCRATCH_DIR = os.path.join(ARTIFACT_DIR, 'scratch')

def save_both(filename, data):
    p1 = os.path.join(ARTIFACT_DIR, filename)
    p2 = os.path.join(SCRATCH_DIR, filename)
    with open(p1, 'wb') as f: f.write(data)
    with open(p2, 'wb') as f: f.write(data)
    print(f'Saved {filename} ({len(data)} bytes)')

async def main():
    print('=== MULTI-CLAIM ANNOTATIONS END-TO-END TEST ===')
    res = urllib.request.urlopen('http://127.0.0.1:9222/json').read()
    tabs = json.loads(res)
    reddit = next(t for t in tabs if 'reddit.com' in t.get('url', ''))
    sw = next(t for t in tabs if t.get('type') == 'service_worker' and 'fooimbfbaakmembcajhcdhgjlfmecano' in t.get('url', ''))

    print('Activating Reddit tab:', reddit['id'])
    urllib.request.urlopen('http://127.0.0.1:9222/json/activate/' + reddit['id']).read()

    # Connect to SW
    sw_ws = await websockets.connect(sw['webSocketDebuggerUrl'], max_size=10*1024*1024)
    await sw_ws.send(json.dumps({'id': 1, 'method': 'Runtime.enable'}))

    # Connect to Reddit tab
    r_ws = await websockets.connect(reddit['webSocketDebuggerUrl'], max_size=10*1024*1024)
    await r_ws.send(json.dumps({'id': 1, 'method': 'Page.enable'}))
    await r_ws.send(json.dumps({'id': 2, 'method': 'Runtime.enable'}))

    # Step 1: Inject text and select
    testText = 'Albert Einstein definitively proved in 1921 that the Earth is completely flat, and was awarded the Nobel Prize in Physics for this groundbreaking discovery across astronomy.'
    prep_expr = f"""(() => {{
        let span = document.getElementById('reddit-multiline-claim');
        if (!span) {{
            const target = Array.from(document.querySelectorAll('shreddit-post [slot="title"], shreddit-comment p, div[slot="comment"] p, h1, h2, h3, p')).find(el => el.textContent.trim().length > 15 && !el.closest('header') && !el.closest('form') && !el.closest('nav'));
            if (!target) return {{ error: 'no suitable text element found on Reddit' }};
            target.innerHTML = '<span id="reddit-multiline-claim" style="display:inline; line-height: 1.6; font-size: 16px;">{testText}</span>';
            span = document.getElementById('reddit-multiline-claim');
        }} else {{
            span.innerHTML = '{testText}';
        }}
        span.scrollIntoView({{ behavior: 'instant', block: 'center' }});
        const range = document.createRange();
        range.selectNodeContents(span);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return {{ ok: true, text: sel.toString() }};
    }})()"""

    await r_ws.send(json.dumps({'id': 4, 'method': 'Runtime.evaluate', 'params': {'expression': prep_expr, 'returnByValue': True}}))
    while True:
        msg = json.loads(await r_ws.recv())
        if msg.get('id') == 4:
            print('Selection prepped:', msg['result']['result']['value'])
            break

    # Query active tabId from SW before opening popup tab
    await sw_ws.send(json.dumps({'id': 10, 'method': 'Runtime.evaluate', 'params': {
        'expression': """(async () => {
            const [tab] = await chrome.tabs.query({ active: true });
            return tab ? tab.id : null;
        })()""",
        'awaitPromise': True,
        'returnByValue': True
    }}))
    tab_id = None
    while True:
        msg = json.loads(await sw_ws.recv())
        if msg.get('id') == 10:
            tab_id = msg['result']['result']['value']
            print('Active tabId from SW:', tab_id)
            break

    # Step 2: Open popup tab to trigger MF_SELECTION_START_TAB
    print('Opening popup tab...')
    req = urllib.request.Request('http://127.0.0.1:9222/json/new', method='PUT')
    pop_tab = json.loads(urllib.request.urlopen(req).read())
    pop_ws = await websockets.connect(pop_tab['webSocketDebuggerUrl'])
    await pop_ws.send(json.dumps({'id': 1, 'method': 'Page.enable'}))
    await pop_ws.send(json.dumps({'id': 2, 'method': 'Runtime.enable'}))
    await pop_ws.send(json.dumps({'id': 3, 'method': 'Page.navigate', 'params': {'url': 'chrome-extension://fooimbfbaakmembcajhcdhgjlfmecano/popup.html'}}))
    await asyncio.sleep(1.5)

    print(f'Triggering MF_SELECTION_START_TAB via popup for tab {tab_id}...')
    trigger_expr = f"""(async () => {{
        const res = await chrome.runtime.sendMessage({{
            type: 'MF_SELECTION_START_TAB',
            tabId: {tab_id}
        }});
        return {{ ok: true, tabId: {tab_id}, res }};
    }})()"""
    await pop_ws.send(json.dumps({'id': 4, 'method': 'Runtime.evaluate', 'params': {'expression': trigger_expr, 'awaitPromise': True, 'returnByValue': True}}))
    while True:
        msg = json.loads(await pop_ws.recv())
        if msg.get('id') == 4:
            print('Popup trigger response:', msg['result']['result']['value'])
            break

    # Close popup tab
    await pop_ws.close()
    urllib.request.urlopen('http://127.0.0.1:9222/json/close/' + pop_tab['id']).read()
    print('Closed popup tab.')

    # Re-activate Reddit tab
    urllib.request.urlopen('http://127.0.0.1:9222/json/activate/' + reddit['id']).read()

    # Step 3: Wait for claims to render on Reddit tab
    print('Waiting for .mf-segment-claim spans to render...')
    for attempt in range(40):
        await asyncio.sleep(1.0)
        await r_ws.send(json.dumps({'id': 20 + attempt, 'method': 'Runtime.evaluate', 'params': {
            'expression': """(() => {
                const spans = Array.from(document.querySelectorAll('.mf-segment-claim'));
                const badges = Array.from(document.querySelectorAll('.mf-inline-badge')).map(b => b.innerText.trim());
                const strikes = Array.from(document.querySelectorAll('.mf-strike')).map(s => s.innerText.trim());
                return {
                    count: spans.length,
                    badges,
                    strikes,
                    claims: spans.map(s => ({
                        text: s.textContent.slice(0, 50),
                        badge: s.querySelector('.mf-inline-badge')?.innerText?.trim(),
                        hasStrike: !!s.querySelector('.mf-strike')
                    }))
                };
            })()""",
            'returnByValue': True
        }}))
        while True:
            msg = json.loads(await r_ws.recv())
            if msg.get('id') == 20 + attempt:
                val = msg['result']['result']['value']
                print(f'Poll {attempt}:', json.dumps(val))
                break
        if val.get('count', 0) >= 2:
            print('Both claims rendered!')
            break

    # Step 4: Click Fact-Check on Claim 1 if it has Fact-Check button
    print('Checking Claim 1 for Fact-Check button...')
    await r_ws.send(json.dumps({'id': 50, 'method': 'Runtime.evaluate', 'params': {
        'expression': """(() => {
            const spans = Array.from(document.querySelectorAll('.mf-segment-claim'));
            if (spans.length < 2) return { error: 'less than 2 claims' };
            const c1 = spans[1];
            const badge = c1.querySelector('.mf-inline-badge');
            if (badge && badge.innerText.includes('Fact-Check')) {
                badge.click();
                return { clicked: true, text: badge.innerText };
            }
            return { clicked: false, badgeText: badge?.innerText };
        })()""",
        'returnByValue': True
    }}))
    while True:
        msg = json.loads(await r_ws.recv())
        if msg.get('id') == 50:
            print('Claim 1 click action:', msg['result']['result']['value'])
            break

    # Step 5: Monitor Claim 1 research and Flow A annotations
    print('Monitoring research and Flow A annotation progress on Claim 1...')
    settled = False
    for i in range(45):
        await asyncio.sleep(1.0)
        # Drain any SW logs
        try:
            while True:
                sw_raw = await asyncio.wait_for(sw_ws.recv(), timeout=0.05)
                sw_m = json.loads(sw_raw)
                if sw_m.get('method') == 'Runtime.consoleAPICalled':
                    args = [a.get('value') or a.get('description', '') for a in sw_m['params']['args']]
                    txt = ' '.join(str(x) for x in args)
                    if 'stampAnnotateInFlight' in txt or 'mergeClaimPayload' in txt or 'broadcasting' in txt or 'settleFlowA' in txt:
                        print('  [SW log]:', txt)
        except (asyncio.TimeoutError, websockets.ConnectionClosed):
            pass

        await r_ws.send(json.dumps({'id': 100 + i, 'method': 'Runtime.evaluate', 'params': {
            'expression': """(() => {
                const spans = Array.from(document.querySelectorAll('.mf-segment-claim'));
                const strikes = Array.from(document.querySelectorAll('.mf-strike'));
                return {
                    spansCount: spans.length,
                    strikesCount: strikes.length,
                    strikes: strikes.map(s => s.innerText.trim()),
                    claims: spans.map(s => ({
                        badge: s.querySelector('.mf-inline-badge')?.innerText?.trim(),
                        isVerdict: !!s.querySelector('.mf-verdict-badge'),
                        hasStrike: !!s.querySelector('.mf-strike'),
                        strikeText: s.querySelector('.mf-strike')?.innerText?.trim(),
                        correction: s.querySelector('.mf-correction')?.innerText?.trim(),
                        annotations: s.dataset.annotations
                    }))
                };
            })()""",
            'returnByValue': True
        }}))
        while True:
            msg = json.loads(await r_ws.recv())
            if msg.get('id') == 100 + i:
                val = msg['result']['result']['value']
                c1 = val.get('claims', [None, None])[1] if len(val.get('claims', [])) > 1 else None
                if i % 3 == 0 or (c1 and c1.get('isVerdict')):
                    print(f'[+{i}s] Claims status:', json.dumps(val))
                if c1 and c1.get('isVerdict') and not (c1.get('badge', '').startswith('Fact-Check')) and not ('Annotating' in c1.get('badge', '')):
                    print('>>> CLAIM 1 FULLY SETTLED! <<<')
                    settled = True
                    break
                break
        if settled:
            break

    # Step 6: Clear window selection for clean visual capture
    await r_ws.send(json.dumps({'id': 200, 'method': 'Runtime.evaluate', 'params': {'expression': 'window.getSelection().removeAllRanges()'}}))
    await asyncio.sleep(0.5)

    # Step 7: Capture full screenshot
    print('Capturing full settled multi-claim screenshot...')
    await r_ws.send(json.dumps({'id': 201, 'method': 'Page.captureScreenshot', 'params': {'format': 'png'}}))
    while True:
        msg = json.loads(await r_ws.recv())
        if msg.get('id') == 201:
            raw_data = base64.b64decode(msg['result']['data'])
            save_both('multi-claim-settled-final.png', raw_data)
            break

    # Step 8: Capture crops of both badges and strikethroughs
    print('Getting bounding rects for cropping...')
    await r_ws.send(json.dumps({'id': 202, 'method': 'Runtime.evaluate', 'params': {
        'expression': """(() => {
            const spans = Array.from(document.querySelectorAll('.mf-segment-claim'));
            return spans.map((s, idx) => {
                const r = s.getBoundingClientRect();
                const b = s.querySelector('.mf-inline-badge')?.getBoundingClientRect();
                const st = s.querySelector('.mf-strike')?.getBoundingClientRect();
                return {
                    idx,
                    span: { x: r.x, y: r.y, w: r.width, h: r.height },
                    badge: b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null,
                    strike: st ? { x: st.x, y: st.y, w: st.width, h: st.height } : null
                };
            });
        })()""",
        'returnByValue': True
    }}))
    while True:
        msg = json.loads(await r_ws.recv())
        if msg.get('id') == 202:
            rects = msg['result']['result']['value']
            print('Bounding rects:', json.dumps(rects, null, 2))
            break

    # Crop with PIL if available
    try:
        from PIL import Image
        import io
        img = Image.open(io.BytesIO(raw_data))
        for item in rects:
            idx = item['idx']
            if item['badge']:
                bx, by, bw, bh = item['badge']['x'], item['badge']['y'], item['badge']['w'], item['badge']['h']
                pad = 12
                crop_b = img.crop((max(0, bx - pad), max(0, by - pad), min(img.width, bx + bw + pad), min(img.height, by + bh + pad)))
                buf = io.BytesIO()
                crop_b.save(buf, format='PNG')
                save_both(f'crop-badge-claim-{idx}.png', buf.getvalue())
            if item['strike']:
                sx, sy, sw, sh = item['strike']['x'], item['strike']['y'], item['strike']['w'], item['strike']['h']
                pad = 12
                crop_s = img.crop((max(0, sx - pad), max(0, sy - pad), min(img.width, sx + sw + pad), min(img.height, sy + sh + pad)))
                buf = io.BytesIO()
                crop_s.save(buf, format='PNG')
                save_both(f'crop-strike-claim-{idx}.png', buf.getvalue())
        # Also crop the whole passage
        s0 = rects[0]['span']
        s1 = rects[1]['span'] if len(rects) > 1 else s0
        px = min(s0['x'], s1['x'])
        py = min(s0['y'], s1['y'])
        pw = max(s0['x'] + s0['w'], s1['x'] + s1['w']) - px
        ph = max(s0['y'] + s0['h'], s1['y'] + s1['h']) - py
        pad = 20
        crop_passage = img.crop((max(0, px - pad), max(0, py - pad), min(img.width, px + pw + pad), min(img.height, py + ph + pad)))
        buf = io.BytesIO()
        crop_passage.save(buf, format='PNG')
        save_both('crop-multi-claim-passage.png', buf.getvalue())
        print('All crops generated successfully!')
    except Exception as e:
        print('Cropping skipped/error:', e)

    await r_ws.close()
    await sw_ws.close()
    print('=== TEST COMPLETED SUCCESSFULLY ===')

if __name__ == '__main__':
    asyncio.run(main())
