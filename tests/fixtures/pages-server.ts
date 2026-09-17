import { createServer } from 'node:http';

export async function startPagesServer(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/slow') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.write('<!doctype html><html><head><title>慢网页</title></head><body>');
      setTimeout(() => response.end('<h1 id="title">加载完成</h1></body></html>'), 300);
      return;
    }
    const title = url.pathname === '/detail' ? '订单详情' : url.pathname === '/report' ? '报表' : '订单列表';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><title>${title}</title></head><body>
      <h1 id="title">${title}</h1>
      <a id="detail" href="/detail" target="_blank">打开详情</a>
      <a id="report" href="/report">打开报表</a>
      <a id="slow" href="/slow" target="_blank">慢网页</a>
      <button id="nothing" onclick="document.body.dataset.clicked = 'true'">无弹页</button>
      <button id="delayed" onclick="setTimeout(() => window.open('/detail'), 120)">延迟详情</button>
      <button id="close" onclick="window.close()">关闭</button>
    </body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
