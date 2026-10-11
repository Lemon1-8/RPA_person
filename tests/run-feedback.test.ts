import { expect, it } from 'vitest';
import type { RunSnapshot } from '../packages/contracts/src/index.js';
import { explainError, runRecovery } from '../apps/desktop/src/renderer/run-feedback.js';

const run: RunSnapshot = { runId: 'r', workflowId: 'a', workflowName: 'A', revision: 1, status: 'running',
  startedAt: new Date().toISOString(), variables: {}, artifacts: [] };
it('去除 IPC 包装但保留原始技术信息，不猜测未知错误原因', () => {
  const error = new Error("Error invoking remote method 'rpa:save': Error: 流程版本已改变，请重新加载后保存。");
  expect(explainError(error)).toEqual({ message: '流程版本已改变，请重新加载后保存。', detail: error.message });
  expect(explainError(new Error('未知原因'))).toEqual({ message: '未知原因', detail: undefined });
});
it('失败和中断允许重新编辑，等待人工允许重试，停止和成功不显示恢复入口', () => {
  expect(runRecovery({ ...run, status: 'failed', currentStepId: 'bad', error: '缺少变量' }, [])).toEqual({ stepId: 'bad', reason: '缺少变量', canResume: false });
  expect(runRecovery({ ...run, status: 'waiting_manual', error: '需要登录' }, [])?.canResume).toBe(true);
  expect(runRecovery({ ...run, status: 'interrupted' }, [])?.canResume).toBe(false);
  for (const status of ['running', 'succeeded', 'stopped', 'paused'] as const) expect(runRecovery({ ...run, status }, [])).toBeUndefined();
});
it('等待网页元素超时显示可操作的中文说明，原始错误留作技术详情', () => {
  const cause = new Error('locator.waitFor: Timeout 200ms exceeded. Call log:\n\u001b[2m waiting for locator("#missing")\u001b[22m');
  expect(explainError(cause).message).toBe('等待网页元素超时（200 毫秒）。请检查选择器和目标网页，或先完成登录。');
  expect(explainError(cause).detail).toBe(cause.message);
});
