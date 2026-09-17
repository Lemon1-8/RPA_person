import { createServer } from 'node:http';

/** Every popup, frame and popup destination is a local controlled test page. */
export async function startPopupFixture() {
  let origin = '';
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><head><meta charset="utf-8"><style>
      .popup,.modal { position:fixed; left:20%; top:20%; width:300px; height:180px; z-index:1001; background:white }
      .backdrop { position:fixed; inset:0; z-index:1000; background:#0008 }
    </style></head><body>
    <header id="navigation" style="position:fixed;top:0;height:40px;width:100%;z-index:2000">Site navigation</header>
    <h1>Controlled popup fixture</h1><button id="normal" style="margin-top:100px">Open invoice</button>
    <a id="link" target="_blank" href="/invoice">View invoice</a><button id="native">Native dialogs</button>
    <button id="business-action">Business action</button><output id="output"></output>
    <script>
      window.addPopup = (id, text, role = 'dialog') => {
        const el = document.createElement('div'); el.id = id; el.className = 'popup'; el.setAttribute('role', role); el.textContent = text; document.body.append(el); return el;
      };
      document.querySelector('#normal').onclick = () => { window.open('/invoice', '_blank'); };
      document.querySelector('#native').onclick = () => { alert('Notice'); window.confirmed = confirm('Confirm order?'); window.prompted = prompt('Value?'); document.querySelector('#output').textContent = 'done'; };
      document.querySelector('#business-action').onclick = () => { document.querySelector('#output').textContent = 'business done'; };
    </script>${request.url === '/frames' ? `<iframe id="child" src="${origin.replace('127.0.0.1', 'localhost')}/child"></iframe>` : ''}
    </body></html>`);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing popup fixture port');
  origin = `http://127.0.0.1:${address.port}`;
  return { url: origin, close: () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }) };
}
