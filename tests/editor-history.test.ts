import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '../packages/contracts/src/index.js';
import { editorReducer, emptyEditorState } from '../apps/desktop/src/renderer/editor-history.js';

function flow(id = 'a'): WorkflowDefinition {
  return { schemaVersion: 1, workflowId: id, name: id, revision: 1, variables: {}, elements: {},
    settings: { downloadDir: 'C:\\RPA', headless: true }, steps: [{ stepId: 'parent', name: '容器', actionType: 'control.if', params: {},
      children: [{ stepId: 'child', name: '内部步骤', actionType: 'core.log', params: { message: '原值' } }],
      elseSteps: [{ stepId: 'else', name: '否则', actionType: 'core.log', params: { message: '否则值' } }] }] };
}
describe('按流程记录编辑历史', () => {
  it('恢复删除的完整子树和选中步骤，重做后再编辑会清空重做记录', () => {
    const original = flow();
    let state = editorReducer(emptyEditorState, { type: 'sync', update: [original] });
    state = editorReducer(state, { type: 'edit', id: 'a', selectedId: 'child', at: 1, update: value => ({ ...value, steps: [] }) });
    expect(state.workflows[0].steps).toEqual([]);
    expect(state.histories.a.past[0].selectedId).toBe('child');
    state = editorReducer(state, { type: 'undo', id: 'a', selectedId: '' });
    expect(state.workflows[0]).toEqual(original);
    state = editorReducer(state, { type: 'redo', id: 'a', selectedId: 'child' });
    expect(state.workflows[0].steps).toEqual([]);
    state = editorReducer(state, { type: 'undo', id: 'a', selectedId: '' });
    state = editorReducer(state, { type: 'edit', id: 'a', selectedId: 'child', at: 2, update: value => ({ ...value, name: '新编辑' }) });
    expect(state.histories.a.future).toEqual([]);
  });
  it('保存后撤销保留最新修订号，不影响其他流程，并清理被删除流程的历史', () => {
    let state = editorReducer(emptyEditorState, { type: 'sync', update: [flow(), flow('b')] });
    state = editorReducer(state, { type: 'edit', id: 'a', selectedId: 'parent', at: 1, update: value => ({ ...value, name: '编辑 A' }) });
    state = editorReducer(state, { type: 'edit', id: 'b', selectedId: 'child', at: 2, update: value => ({ ...value, name: '编辑 B' }) });
    state = editorReducer(state, { type: 'sync', update: values => values.map(value => value.workflowId === 'a' ? { ...value, revision: 2 } : value) });
    state = editorReducer(state, { type: 'undo', id: 'a', selectedId: 'parent' });
    expect(state.workflows[0]).toMatchObject({ name: 'a', revision: 2 });
    expect(state.workflows[1].name).toBe('编辑 B');
    state = editorReducer(state, { type: 'undo', id: 'b', selectedId: 'child' });
    expect(state.workflows[1].name).toBe('b');
    state = editorReducer(state, { type: 'sync', update: values => values.filter(value => value.workflowId !== 'a') });
    expect(state.histories.a).toBeUndefined();
  });
  it('合并同一字段的连续输入，跨字段或较晚输入建立独立记录', () => {
    let state = editorReducer(emptyEditorState, { type: 'sync', update: [flow()] });
    for (const [name, group, at] of [['一', 'name', 10], ['二', 'name', 20], ['三', 'other', 30], ['四', 'other', 1000]] as const) {
      state = editorReducer(state, { type: 'edit', id: 'a', selectedId: 'parent', group, at, update: value => ({ ...value, name }) });
    }
    expect(state.histories.a.past.map(entry => entry.workflow.name)).toEqual(['a', '二', '三']);
  });
});
