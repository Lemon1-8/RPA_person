import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowEngine } from '../packages/engine/src/index.js';
import { runDesktopInput } from '../packages/engine/src/desktop-input.js';
vi.mock('../packages/engine/src/desktop-input.js', () => ({runDesktopInput:vi.fn(async () => {throw new Error('INPUT_INTERRUPTED: 用户已接管');})}));

it('脚本不能吞掉真实输入接管后继续发送操作', async () => {
  const directory = await mkdtemp(join(tmpdir(),'rpa-agent-input-'));
  let manual = '';
  const engine = new WorkflowEngine({schemaVersion:1,workflowId:'guard',name:'保护',revision:0,variables:{},elements:{},settings:{headless:true,downloadDir:directory},steps:[{stepId:'script',name:'脚本',actionType:'script.run',params:{language:'javascript',code:"try { await rpa.call('desktop.mouseMove',{x:1,y:1}); } catch {} await rpa.call('desktop.mouseMove',{x:2,y:2}); await rpa.output('不得完成');"}}]}, {dataDir:directory,runId:'guard',agentMode:true,onEvent:event => {
    if (event.run?.status === 'waiting_manual') {manual = event.run.error ?? '';void engine.control('stop');}
  }});
  try {
    expect((await engine.run()).status).toBe('stopped');
    expect(manual).toContain('INPUT_INTERRUPTED');
    expect(runDesktopInput).toHaveBeenCalledTimes(1);
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('rpa-agent-input-')) throw new Error('拒绝清理测试目录以外的路径');
    await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
