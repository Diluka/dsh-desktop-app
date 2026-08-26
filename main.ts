const home = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>DSH Desktop</title>
  </head>
  <body>
    <main>
      <h1>DSH Desktop</h1>
      <p>Remote mode bootstrap is ready.</p>
    </main>
  </body>
</html>`;

Deno.serve(() =>
  new Response(home, {
    headers: { "content-type": "text/html; charset=utf-8" },
  })
);
