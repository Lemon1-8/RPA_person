import type { WorkflowDefinition } from '../../../../packages/contracts/src/index.js';

export interface EditorEntry { workflow: WorkflowDefinition; selectedId: string }
export interface EditorHistory { past: EditorEntry[]; future: EditorEntry[]; group?: string; at?: number }
export interface EditorState { workflows: WorkflowDefinition[]; histories: Record<string, EditorHistory>; restored: number }
type EditorAction =
  | { type: 'sync'; update: WorkflowDefinition[] | ((workflows: WorkflowDefinition[]) => WorkflowDefinition[]) }
  | { type: 'edit'; id: string; update: (workflow: WorkflowDefinition) => WorkflowDefinition; selectedId: string; group?: string; at: number }
  | { type: 'undo' | 'redo'; id: string; selectedId: string };
export const emptyEditorState: EditorState = { workflows: [], histories: {}, restored: 0 };

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  if (action.type === 'sync') {
    const workflows = typeof action.update === 'function' ? action.update(state.workflows) : action.update;
    const histories = Object.fromEntries(workflows.filter(flow => state.histories[flow.workflowId]).map(flow => [flow.workflowId,
      { ...state.histories[flow.workflowId]!, group: undefined }]));
    return { ...state, workflows, histories };
  }
  const workflow = state.workflows.find(flow => flow.workflowId === action.id);
  if (!workflow) return state;
  const history = state.histories[action.id] ?? { past: [], future: [] };
  let next: WorkflowDefinition;
  let nextHistory: EditorHistory;
  if (action.type === 'edit') {
    next = action.update(workflow);
    if (JSON.stringify(next) === JSON.stringify(workflow)) return state;
    const grouped = action.group && history.group === action.group && action.at - (history.at ?? 0) < 700;
    nextHistory = { past: grouped ? history.past : [...history.past, { workflow, selectedId: action.selectedId }].slice(-100),
      future: [], group: action.group, at: action.at };
  } else {
    const source = action.type === 'undo' ? history.past : history.future;
    const entry = source.at(-1);
    if (!entry) return state;
    // 保存版本号是存储的并发凭据，撤销只恢复编辑内容。
    next = { ...entry.workflow, revision: workflow.revision };
    const current = { workflow, selectedId: action.selectedId };
    nextHistory = action.type === 'undo' ? { past: source.slice(0, -1), future: [...history.future, current] }
      : { past: [...history.past, current].slice(-100), future: source.slice(0, -1) };
  }
  return { workflows: state.workflows.map(flow => flow.workflowId === action.id ? next : flow),
    histories: { ...state.histories, [action.id]: nextHistory }, restored: state.restored + (action.type === 'edit' ? 0 : 1) };
}
