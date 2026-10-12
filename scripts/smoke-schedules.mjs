import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import assert from 'node:assert/strict';
const root = process.cwd(); const data = await mkdtemp(join(tmpdir(), 'rpa-calendar-ui-'));
const env = { ...process.env, RPA_ROOT:root, RPA_DATA_DIR:data }; delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ executablePath:createRequire(import.meta.url)('electron'),args:['.'],cwd:root,env });
  const page = await app.firstWindow(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.getByLabel('当前流程',{exact:true}).waitFor();
  await page.getByRole('button',{name:'定时运行',exact:true}).click();
  await page.getByRole('button',{name:'新建定时任务',exact:true}).click();
  await page.getByLabel('触发方式',{exact:true}).selectOption('monthly');
  await page.getByRole('spinbutton',{name:'每月日期（缺日按月末）'}).fill('31');
  await page.getByText('未来五次触发时间（本机时区）',{exact:true}).click();
  assert.equal(await page.locator('.schedule-form ol li').count(),5);
  assert.equal(await page.locator('.schedule-form').getByText('固定 v1',{exact:true}).count(),1);
  await mkdir(resolve('.rpa/qa'),{recursive:true}); await page.screenshot({path:resolve('.rpa/qa/calendar-normal.png')});
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1000,760));
  await page.screenshot({path:resolve('.rpa/qa/calendar-minimum.png')});
  await page.getByRole('button',{name:'保存定时任务',exact:true}).click();
  await page.locator('.management-table tbody tr').first().waitFor();
  const plans = await page.evaluate(() => window.rpa.listSchedules());
  assert.equal(plans[0].revision,1); assert.equal(plans[0].day,31);
  assert.deepEqual(errors,[]); console.log('日历计划、固定修订及正常/小窗口界面验收通过');
} finally {
  await app?.close();
  if (dirname(resolve(data)) !== resolve(tmpdir()) || !basename(data).startsWith('rpa-calendar-ui-')) throw new Error('拒绝清理非验收目录');
  await rm(data,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
