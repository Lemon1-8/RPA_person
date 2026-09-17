import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const data = await mkdtemp(join(tmpdir(), 'rpa-note-'));
const qa = resolve('.rpa/qa');
await mkdir(qa, { recursive: true });
const require = createRequire(import.meta.url);
const env = { ...process.env, RPA_ROOT: root, RPA_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let app;
let page;

async function bootstrap() { return page.evaluate(() => window.rpa.bootstrap()); }
function stepButton(name) { return page.getByRole('button', { name: new RegExp(`^步骤 \\d+：${name}$`) }); }
async function save() {
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('未保存', { exact: true }).waitFor({ state: 'hidden' });
}

async function addNestedNote(name) {
  await page.getByRole('group', { name: '备注验收循环：循环体', exact: true })
    .getByRole('button', { name: '添加到循环体', exact: true }).click();
  await page.getByRole('group', { name: '选择要添加的指令', exact: true }).getByRole('button', { name: '备注', exact: true }).click();
  await page.getByRole('complementary', { name: '参数与设置', exact: true }).getByLabel('步骤名称', { exact: true }).fill(name);
  await stepButton(name).waitFor();
}

function rgb(hex) {
  return `rgb(${[1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16)).join(', ')})`;
}

function luminance(color) {
  const channels = color.match(/[\d.]+/g).slice(0, 3).map(channel => {
    const component = Number(channel) / 255;
    return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground, background) {
  const levels = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (levels[0] + 0.05) / (levels[1] + 0.05);
}

async function assertNoteAppearance(name, color, text) {
  const button = stepButton(name);
  const expected = rgb(color);
  await page.waitForFunction(({ element, expected }) => getComputedStyle(element.closest('article')).backgroundColor === expected,
    { element: await button.elementHandle(), expected });
  const appearance = await button.evaluate(element => {
    const row = element.closest('article');
    const body = row.querySelector('.note-content');
    const title = row.querySelector('.step-copy strong');
    return {
      background: getComputedStyle(row).backgroundColor,
      titleColor: getComputedStyle(title).color,
      bodyColor: getComputedStyle(body).color,
      text: body.textContent,
      whiteSpace: getComputedStyle(body).whiteSpace,
    };
  });
  assert.equal(appearance.background, expected, `${name} 的整行背景应保持所选颜色`);
  assert.equal(appearance.text, text, '备注正文应完整保留换行和双花括号');
  assert.ok(['pre', 'pre-wrap', 'pre-line', 'break-spaces'].includes(appearance.whiteSpace), '备注行应保留多行排版');
  assert.ok(contrast(appearance.titleColor, appearance.background) >= 4.5, `${name} 标题颜色应可读`);
  assert.ok(contrast(appearance.bodyColor, appearance.background) >= 4.5, `${name} 正文颜色应可读`);
  return appearance;
}

try {
  app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: root, env });
  page = await app.firstWindow();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.getByRole('heading', { name: '订单采集与导出', exact: true }).waitFor();
  const initial = await bootstrap();
  const flow = {
    ...initial.workflows[0], name: '彩色备注验收', variables: {}, elements: {},
    settings: { downloadDir: join(data, 'downloads'), headless: true, keepBrowserOpen: false },
    steps: [
      { stepId: 'start', name: '准备流程', actionType: 'variables.set', params: { name: 'started', value: true } },
      { stepId: 'loop', name: '备注验收循环', actionType: 'control.forEach', params: { items: [1, 2], itemVariable: 'item' }, children: [] },
      { stepId: 'after', name: '备注后继续执行', actionType: 'variables.set', params: { name: 'finished', value: true } },
    ],
  };
  await page.evaluate(workflow => window.rpa.saveWorkflow(workflow), flow);
  await page.reload();
  await page.getByRole('heading', { name: flow.name, exact: true }).waitFor();
  const inspector = page.getByRole('complementary', { name: '参数与设置', exact: true });
  const library = page.getByRole('complementary', { name: '指令库', exact: true });
  await stepButton('准备流程').click();
  await library.getByRole('button', { name: '备注', exact: true }).click();
  await inspector.getByLabel('步骤名称', { exact: true }).fill('金色备注');
  const noteText = '采集前检查登录状态\n{{literal}} 是备注原文，不读取变量。\n执行后人工核对。';
  assert.equal(await inspector.getByLabel('备注内容', { exact: true }).inputValue(), '');
  assert.equal((await inspector.getByLabel('备注颜色代码', { exact: true }).inputValue()).toUpperCase(), '#FFE08A');
  assert.equal(await inspector.getByLabel('选择备注颜色', { exact: true }).getAttribute('type'), 'color');
  assert.equal(await inspector.getByRole('button', { name: '为备注内容插入变量', exact: true }).count(), 0, '备注不提供变量插值');
  assert.equal(await inspector.getByLabel(/^输出变量/).count(), 0, '备注不应要求输出变量');
  await inspector.getByLabel('备注内容', { exact: true }).fill(noteText);
  await inspector.getByRole('button', { name: '使用浅绿色', exact: true }).click();
  await assertNoteAppearance('金色备注', '#C7EBD2', noteText);
  await inspector.getByRole('button', { name: '使用金黄色', exact: true }).click();
  await assertNoteAppearance('金色备注', '#FFE08A', noteText);

  await page.getByRole('button', { name: '复制 金色备注', exact: true }).click();
  await stepButton('金色备注 副本').waitFor();
  assert.equal(await inspector.getByLabel('备注内容', { exact: true }).inputValue(), noteText, '复制备注必须保留正文');
  assert.equal((await inspector.getByLabel('备注颜色代码', { exact: true }).inputValue()).toUpperCase(), '#FFE08A', '复制备注必须保留颜色');
  await inspector.getByLabel('步骤名称', { exact: true }).fill('粉色复核说明');
  const copiedText = '复核说明\n仍保留 {{literal}} 原文。';
  await inspector.getByLabel('备注内容', { exact: true }).fill(copiedText);
  await inspector.getByLabel('备注颜色代码', { exact: true }).fill('#EFC9EA');
  await inspector.getByLabel('备注颜色代码', { exact: true }).blur();
  await assertNoteAppearance('粉色复核说明', '#EFC9EA', copiedText);

  await addNestedNote('深蓝循环说明');
  const nestedText = '循环内说明\n{{item}} 与 {{missingNoteVariable}} 均不求值。';
  await inspector.getByLabel('备注内容', { exact: true }).fill(nestedText);
  await inspector.getByRole('button', { name: '使用深蓝色', exact: true }).click();
  await assertNoteAppearance('深蓝循环说明', '#253858', nestedText);
  await addNestedNote('浅蓝补充说明');
  const nativeText = '补充说明\n可通过颜色选择器调整整行背景。';
  await inspector.getByLabel('备注内容', { exact: true }).fill(nativeText);
  await inspector.getByLabel('选择备注颜色', { exact: true }).evaluate((element, color) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, color);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, '#cfe3ff');
  await assertNoteAppearance('浅蓝补充说明', '#CFE3FF', nativeText);
  const outer = await stepButton('备注验收循环').boundingBox();
  const nested = await stepButton('深蓝循环说明').boundingBox();
  assert.ok(outer && nested && nested.x >= outer.x + 16, '循环内的备注应逐层缩进');
  await save();
  const saved = (await bootstrap()).workflows.find(item => item.workflowId === flow.workflowId);
  const notes = [saved.steps[1], saved.steps[2], ...saved.steps[3].children];
  const expected = [
    ['金色备注', '#FFE08A', noteText],
    ['粉色复核说明', '#EFC9EA', copiedText],
    ['深蓝循环说明', '#253858', nestedText],
    ['浅蓝补充说明', '#CFE3FF', nativeText],
  ];
  assert.equal(saved.schemaVersion, 1);
  assert.equal(new Set(notes.map(note => note.stepId)).size, 4, '复制与新增备注必须产生独立标识');
  for (const [index, [name, color, text]] of expected.entries()) {
    assert.equal(notes[index].actionType, 'core.note');
    assert.equal(notes[index].name, name);
    assert.equal(notes[index].params.text, text);
    assert.equal(notes[index].params.color.toUpperCase(), color);
  }
  await page.reload();
  await stepButton('金色备注').waitFor();
  assert.deepEqual((await bootstrap()).workflows.find(item => item.workflowId === flow.workflowId), saved);
  for (const [name, color, text] of expected) {
    await stepButton('备注后继续执行').click();
    await stepButton(name).hover();
    await assertNoteAppearance(name, color, text);
    await stepButton(name).click();
    await assertNoteAppearance(name, color, text);
    assert.equal(await inspector.getByLabel('备注内容', { exact: true }).inputValue(), text);
    assert.equal((await inspector.getByLabel('备注颜色代码', { exact: true }).inputValue()).toUpperCase(), color);
  }

  await page.evaluate(() => {
    window.noteSmokeEvents = [];
    window.rpa.onEvent(event => window.noteSmokeEvents.push(event));
  });
  const previous = new Set((await bootstrap()).runs.map(run => run.runId));
  await page.getByRole('button', { name: '运行', exact: true }).click();
  const deadline = Date.now() + 30_000;
  let run;
  do {
    run = (await bootstrap()).runs.find(item => item.workflowId === flow.workflowId && !previous.has(item.runId));
    if (run && ['succeeded', 'failed', 'stopped', 'interrupted'].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.equal(run?.status, 'succeeded', run?.error);
  assert.equal(run.browserOpen, false, '备注不能启动浏览器');
  assert.equal(run.variables.finished, true, '备注完成后应正常继续执行');
  assert.equal(run.variables.literal, undefined);
  assert.equal(run.variables.missingNoteVariable, undefined);
  const events = (await page.evaluate(() => window.noteSmokeEvents)).filter(event => event.runId === run.runId);
  const noteIds = new Set(notes.map(note => note.stepId));
  assert.equal(events.some(event => event.type === 'log' && noteIds.has(event.stepId)), false, '备注正文不能打印成运行日志');
  assert.equal(events.some(event => event.type === 'log' && /literal|missingNoteVariable|采集前检查|复核说明/.test(event.message ?? '')), false);
  assert.equal(events.some(event => event.run?.browserOpen), false, '执行过程中也不能打开浏览器');
  await page.setViewportSize({ width: 1540, height: 1200 });
  await page.getByRole('button', { name: '收起底部栏', exact: true }).click();
  await stepButton('深蓝循环说明').click();
  for (const [name, color, text] of expected) await assertNoteAppearance(name, color, text);
  await page.screenshot({ path: join(qa, 'note-success.png'), fullPage: true });
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
  console.log(JSON.stringify({ status: 'passed', libraryInsertion: true, multilineLiteralText: true, presetHexAndNativeColors: true, copyPreservesContent: true, nestedNotes: true, savedAndReloaded: true, readableContrasts: true, hoverAndSelectedKeepColor: true, notesExecuteWithoutInterpolationOrLogs: true, browserNotRequired: true, screenshot: join(qa, 'note-success.png') }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(qa, 'note-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  try { if (app) await app.close(); }
  finally {
    const target = resolve(data);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-note-')) throw new Error('拒绝清理非验收临时目录');
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
