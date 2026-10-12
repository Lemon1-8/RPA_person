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
  assert.deepEqual(errors, []); await mkdir(resolve('.rpa/qa'), { recursive: true });
  await page.screenshot({ path: resolve('.rpa/qa/reliability-success.png'), fullPage: true });
  console.log(JSON.stringify({ status: 'passed', invalidDraftRecovery: true, revisions: true }));
} finally {
  if (app) await app.close();
  if (dirname(resolve(data)) !== resolve(tmpdir()) || !basename(data).startsWith('rpa-reliability-')) throw new Error('拒绝清理非验收目录');
  await rm(data, { recursive: true, force: true });
}
