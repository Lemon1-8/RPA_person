// 粘贴到 JavaScript 脚本指令；先在桌面元素库捕获并保存这三个元素。
const input = await rpa.call('windows.find', { selector: '@搜索框' });
await rpa.call('windows.fill', { element: input.element, value: '订单编号', mode: 'api' });
await rpa.call('windows.click', { selector: '@查询按钮' });
await rpa.call('windows.wait', { selector: '@结果', state: 'visible' });
await rpa.output(await rpa.call('windows.text', { selector: '@结果' }));
