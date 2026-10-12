import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { editSelectedSteps, listSteps } from '../apps/desktop/src/renderer/step-editing.js';
import { preflight } from '../packages/actions/src/preflight.js';
import type { StepDefinition, WorkflowDefinition } from '../packages/contracts/src/index.js';
const step: StepDefinition = { stepId: 'set', name: '设置', actionType: 'variables.set', params: { name: 'value', value: 1 } };
const container: StepDefinition = { stepId: 'if', name: '条件', actionType: 'control.if', params: { left: true, operator: 'truthy' }, children: [step] };
const workflow = (steps: StepDefinition[]): WorkflowDefinition => ({ schemaVersion: 1, workflowId: 'preflight', name: '检查', revision: 0, variables: {}, elements: {}, steps, settings: { downloadDir: tmpdir(), headless: true } });
describe('编辑和运行前检查', () => {
  it('Python中文脚本只检查语法，不受Windows默认编码影响也不执行代码', async () => { const issues = await preflight(workflow([{ stepId: 'python', name: '中文脚本', actionType: 'script.run', params: { language: 'python', code: 'print("中文脚本")\nraise RuntimeError("不应执行")' } }])); expect(issues.filter(issue => issue.level === 'error')).toEqual([]); });
  it('批量复制只复制顶层选择，重新生成整个子树标识', () => { const result = editSelectedSteps([container], ['if','set'], 'copy'); expect(result).toHaveLength(2); expect(new Set(listSteps(result).map(step => step.stepId)).size).toBe(4); });
  it('跨分支移动完整子树，拒绝移入自身后代', () => { const result = editSelectedSteps([container, { ...container, stepId: 'other', children: [] }], ['set'], 'move', 'other:children'); expect(result[0].children).toEqual([]); expect(result[1].children?.[0].stepId).toBe('set'); expect(() => editSelectedSteps([container], ['if'], 'move', 'set')).toThrow('自身'); });
  it('批量删除容器及后代，同时保留未选步骤', () => { const result = editSelectedSteps([container, { ...step, stepId: 'after' }], ['if','set'], 'delete'); expect(result.map(step => step.stepId)).toEqual(['after']); });
  it('整流程检测确定错误，注释步骤不产生参数错误', async () => { const issues = await preflight(workflow([{ ...step, params: { name: '', value: 1 } }, { ...step, stepId: 'disabled', disabled: true, params: {} }])); expect(issues.filter(issue => issue.level === 'error')).toHaveLength(1); expect(issues[0].stepId).toBe('set'); });
  it('校验前序变量与分支输出，不执行网页或脚本业务代码', async () => { const result = await preflight(workflow([container, { ...step, stepId: 'read', params: { name: 'copy', value: '{{value}}' } }, { ...step, stepId: 'missing', params: { name: 'other', value: '{{missing}}' } }])); expect(result.some(issue => issue.level === 'error' && issue.stepId === 'read')).toBe(false); expect(result.some(issue => issue.level === 'error' && issue.stepId === 'missing')).toBe(true); });
});
