import { createServer, type Server } from 'node:http';

const orders = [
  { id: 'ORD-1001', customer: 'Alice', amount: 128, status: 'paid' },
  { id: 'ORD-1002', customer: 'Bob', amount: 256, status: 'pending' },
  { id: 'ORD-1003', customer: 'Alice', amount: 64, status: 'paid' },
];

function selectOrders(customer: string) {
  if (!customer) return orders;
  const matches = orders.filter((order) => order.customer === customer);
  return matches.length ? matches : [{ id: 'ORD-DEMO', customer, amount: 32, status: 'paid' }];
}

/** Controlled local website; every route and order is owned by this project. */
export async function startFixtureServer(): Promise<{ url: string; close(): Promise<void> }> {
  let origin = '';
  let requestSequence = 0;
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', origin || 'http://127.0.0.1');
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/api/orders') {
      const requestId = ++requestSequence;
      const delay = Math.max(0, Math.min(3000, Number(url.searchParams.get('delayMs') ?? 120)));
      await new Promise((resolve) => setTimeout(resolve, delay));
      const customer = url.searchParams.get('customer') ?? '';
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ requestId, customer, orders: selectOrders(customer) }));
      return;
    }
    if (url.pathname === '/download') {
      await new Promise((resolve) => setTimeout(resolve, 180));
      const customer = url.searchParams.get('customer') ?? '';
      const selected = selectOrders(customer);
      response.setHeader('Content-Type', 'text/csv; charset=utf-8');
      response.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
      response.end(`order_id,customer,amount,status\n${selected.map((order) => `${order.id},${order.customer},${order.amount},${order.status}`).join('\n')}\n`);
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/frame/outer') {
      response.end('<!doctype html><html><body><h2>Outer frame</h2><iframe id="inner-frame" src="/frame/inner"></iframe></body></html>');
      return;
    }
    if (url.pathname === '/frame/inner') {
      response.end('<!doctype html><html><body><label>Frame value <input id="frame-input"></label><p id="frame-text">Nested frame ready</p></body></html>');
      return;
    }
    if (url.pathname !== '/') {
      response.statusCode = 404;
      response.end('Not found');
      return;
    }
    // localhost and 127.0.0.1 are different origins, exercising cross-origin frame traversal.
    const frameOrigin = origin.replace('127.0.0.1', 'localhost');
    response.end(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>RPA 受控订单演示</title>
<style>body{font:16px system-ui;max-width:900px;margin:40px auto;color:#18302b;background:#f5f7f4}button,input,select{font:inherit;padding:8px;margin:6px}table{border-collapse:collapse;width:100%;background:white}td,th{padding:12px;border-bottom:1px solid #d6dfd7;text-align:left}iframe{margin-top:24px;width:100%;height:220px;border:1px solid #d6dfd7}</style></head>
<body><h1>受控订单演示</h1><p>此页面只包含本地测试数据，用于验证查询、脚本接力和文件下载。</p>
<label>客户 <input id="customer" placeholder="Alice 或 Bob"></label>
<label>状态 <select id="order-status"><option value="all">全部</option><option value="paid">已付款</option><option value="pending">待付款</option></select></label>
<button id="query">查询订单</button><button id="fetch-response">采集响应</button><button id="download">导出 CSV</button>
<p id="status">准备就绪</p><div id="script-state">尚未由脚本更新</div>
<table id="orders"><thead><tr><th>订单号</th><th>客户</th><th>金额</th><th>状态</th></tr></thead><tbody></tbody></table>
<button class="ambiguous">重复按钮 A</button><button class="ambiguous">重复按钮 B</button>
<iframe id="outer-frame" src="${frameOrigin}/frame/outer"></iframe>
<script>
const customer = document.querySelector('#customer');
const status = document.querySelector('#status');
const body = document.querySelector('#orders tbody');
async function query() {
  status.textContent = '查询中';
  const result = await fetch('/api/orders?customer=' + encodeURIComponent(customer.value)).then(r => r.json());
  const selected = document.querySelector('#order-status').value;
  const visible = result.orders.filter(order => selected === 'all' || order.status === selected);
  body.replaceChildren(...visible.map(order => {
    const row = document.createElement('tr');
    for (const value of [order.id, order.customer, order.amount, order.status]) {
      const cell = document.createElement('td'); cell.textContent = String(value); row.append(cell);
    }
    return row;
  }));
  status.textContent = '查询完成：' + (customer.value || '全部客户') + '，已找到 ' + visible.length + ' 条订单';
}
document.querySelector('#query').onclick = query;
document.querySelector('#fetch-response').onclick = query;
document.querySelector('#download').onclick = () => {
  status.textContent = '正在生成导出文件';
  setTimeout(() => { const a = document.createElement('a'); a.href = '/download?customer=' + encodeURIComponent(customer.value); a.download = 'orders.csv'; document.body.append(a); a.click(); a.remove(); status.textContent = '导出已发起'; }, 100);
};
</script></body></html>`);
  });
  // Bind both IPv4 and IPv6 so the cross-origin localhost iframe resolves reliably.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('演示服务器未绑定 TCP 端口');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: origin,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
