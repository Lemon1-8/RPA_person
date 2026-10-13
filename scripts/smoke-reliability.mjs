import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import assert from 'node:assert/strict';
const root = process.cwd(); const data = await mkdtemp(join(tmpdir(), 'rpa-reliability-'));
const env = { ...process.env, RPA_ROOT: root, RPA_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: ['.'], cwd: root, env });
  const page = await app.firstWindow(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.getByLabel('当前流程', { exact: true }).waitFor();
  const flow = await page.evaluate(async () => {
    const state = await window.rpa.bootstrap();
    return window.rpa.saveWorkflow({ ...state.workflows[0], workflowId: 'draft-check', revision: 0, name: '可靠性验收', variables: {}, steps: [{ stepId: 'value', name: '设置值', actionType: 'variables.set', params: { name: 'value', value: {} } }] });
  });
  await page.reload(); await page.getByLabel('当前流程', { exact: true }).selectOption(flow.workflowId);
  await page.getByRole('button', { name: '步骤 1：设置值', exact: true }).click();
  const field = page.getByRole('textbox', { name: '变量值（JSON）', exact: true });
  await field.fill('{"未完成":');
  const deadline = Date.now() + 15000;
  while (!(await page.evaluate(id => window.rpa.listDrafts().then(drafts => drafts.some(draft => draft.workflowId === id && Object.values(draft.fieldTexts).includes('{"未完成":'))), flow.workflowId))) {
    if (Date.now() > deadline) throw new Error('草稿未落盘');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await page.reload(); await page.getByLabel('当前流程', { exact: true }).waitFor();
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await page.getByRole('button', { name: '步骤 1：设置值', exact: true }).click();
  assert.equal(await field.inputValue(), '{"未完成":'); assert.equal(await field.getAttribute('aria-invalid'), 'true');
  await field.fill('{"恢复成功":true}'); await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('.toast').filter({ hasText: '流程已保存' }).waitFor();
  const revisions = await page.evaluate(id => window.rpa.listRevisions(id), flow.workflowId); assert.deepEqual(revisions.map(value => value.revision), [2, 1]);
  const old = await page.evaluate(({ id, revision }) => window.rpa.restoreRevision(id, 1, revision), { id: flow.workflowId, revision: 2 }); assert.equal(old.revision, 3);
  async function awaitState(runId, status, ready = () => true) {
    const until = Date.now() + 15000;
    do {
      const run = (await page.evaluate(() => window.rpa.bootstrap())).runs.find(run => run.runId === runId);
      if (run?.status === status && ready(run)) return run;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < until);
    throw new Error(`任务 ${runId} 未达到 ${status}`);
  }
  async function startManual(id, checks = []) {
    return page.evaluate(async ({ base, id, checks }) => {
      const saved = await window.rpa.saveWorkflow({ ...base, workflowId: id, revision: 0, variables: { actual: 0 }, settings: { ...base.settings, headless: true, keepBrowserOpen: false },
        steps: [{ stepId: 'fail', name: '人工恢复', actionType: 'core.assert', params: { actual: '{{actual}}', expected: 1 }, onError: 'manual', recoveryChecks: checks }] });
      return window.rpa.runWorkflow(saved);
    }, { base: flow, id, checks });
  }
  const retry = await startManual('manual-retry', [{ stepId: 'repair', name: '核对后设置结果', actionType: 'variables.set', params: { name: 'actual', value: 1 } }]);
  await awaitState(retry.runId, 'waiting_manual');
  await page.evaluate(async id => { await window.rpa.controlRun(id, 'check'); await window.rpa.controlRun(id, 'retry'); }, retry.runId);
  assert.equal((await awaitState(retry.runId, 'succeeded')).variables.actual, 1);
  for (const command of ['confirm', 'skip']) {
    const run = await startManual('manual-' + command); await awaitState(run.runId, 'waiting_manual');
    await page.evaluate(({ id, command }) => window.rpa.controlRun(id, command), { id: run.runId, command });
    assert.equal((await awaitState(run.runId, 'succeeded')).warningCount, command === 'skip' ? 1 : 0);
  }
  const debug = await page.evaluate(async base => {
    const saved = await window.rpa.saveWorkflow({ ...base, workflowId: 'debug-controls', revision: 0, variables: {}, settings: { ...base.settings, headless: true }, steps: [
      { stepId: 'first', name: '第一步', actionType: 'variables.set', params: { name: 'first', value: 1 } },
      { stepId: 'second', name: '第二步', actionType: 'variables.set', params: { name: 'second', value: 2 } },
    ] }); return window.rpa.debugRun(saved, ['first']);
  }, flow);
  await awaitState(debug.runId, 'paused'); await page.evaluate(id => window.rpa.controlRun(id, 'step'), debug.runId);
  const stepped = await awaitState(debug.runId, 'paused', run => run.variables.first === 1);
  assert.equal(stepped.variables.second, undefined);
  await page.evaluate(id => window.rpa.controlRun(id, 'resume'), debug.runId);
  assert.equal((await awaitState(debug.runId, 'succeeded')).variables.second, 2);
  assert.deepEqual(errors, []); await mkdir(resolve('.rpa/qa'), { recursive: true });
  await page.screenshot({ path: resolve('.rpa/qa/reliability-success.png'), fullPage: true });
  console.log(JSON.stringify({ status: 'passed', invalidDraftRecovery: true, revisions: true, manualControls: true, debugControls: true }));
} finally {
  if (app) await app.close();
  if (dirname(resolve(data)) !== resolve(tmpdir()) || !basename(data).startsWith('rpa-reliability-')) throw new Error('拒绝清理非验收目录');
  await rm(data, { recursive: true, force: true });
}
