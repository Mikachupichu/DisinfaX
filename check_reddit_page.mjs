const list = await (await fetch("http://127.0.0.1:9222/json")).json();
const redditTab = list.find(t => t.url.includes("reddit.com"));
const ws = new WebSocket(redditTab.webSocketDebuggerUrl);
ws.onopen = () => {
  ws.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: {
      expression: `(() => {
        const post = document.querySelector('shreddit-post');
        const title = post?.querySelector('[slot="title"]') || post?.querySelector('h2') || post?.querySelector('a[id*="post-title"]');
        return {
          hasPost: !!post,
          titleText: title?.textContent?.trim(),
          titleTag: title?.tagName
        };
      })()`,
      returnByValue: true
    }
  }));
};
ws.onmessage = (msg) => {
  const res = JSON.parse(msg.data);
  if (res.id === 1) {
    console.log("Post title info:", JSON.stringify(res.result.result.value, null, 2));
    ws.close();
    process.exit(0);
  }
};
