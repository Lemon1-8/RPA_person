import type { RunEvent, RunSnapshot } from '../../../../packages/contracts/src/index.js';
export const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;]*m/g, '');

export function explainError(cause: unknown): { message: string; detail?: string } {
  const detail = cause instanceof Error ? cause.message : String(cause);
  let message = stripAnsi(detail).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '').trim();
  const waitTimeout = /locator\.waitFor: Timeout (\d+)ms exceeded/.exec(message);
  if (waitTimeout) message = `等待网页元素超时（${waitTimeout[1]} 毫秒）。请检查选择器和目标网页，或先完成登录。`;
  else if (/\b(?:EACCES|EPERM)\b/.test(message)) message = '所选路径无法访问。请更换目录或调整访问权限后重试。';
  return { message: message || '操作未完成，请重试。', detail: message !== detail ? detail : undefined };
}

export function runRecovery(run: RunSnapshot | undefined, events: RunEvent[]) {
  if (!run || !['failed', 'interrupted', 'waiting_manual'].includes(run.status) && !(run.status === 'paused' && run.error)) return undefined;
  const failure = [...events].reverse().find(event => event.runId === run.runId && event.type === 'step' && event.status === 'failed');
  return { stepId: run.currentStepId ?? failure?.stepId,
    reason: explainError(run.error ?? failure?.message ?? '运行已中断，请检查步骤参数后重新运行。').message,
    canResume: run.status === 'waiting_manual' || run.status === 'paused' };
}
