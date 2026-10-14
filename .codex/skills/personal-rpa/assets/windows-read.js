// element 是业务输入中的 UIA 引用，由窗口条件和控件路径组成。
export async function main(rpa) {
  const element = await rpa.get('element');
  const found = await rpa.call('windows.find', { element });
  await rpa.output(await rpa.call('windows.text', { element: found.element }));
}
