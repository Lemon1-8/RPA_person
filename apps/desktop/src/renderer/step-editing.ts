import type { StepDefinition } from '../../../../packages/contracts/src/index.js';
export function listSteps(steps: StepDefinition[]): StepDefinition[] { return steps.flatMap(step => [step, ...listSteps(step.children ?? []), ...listSteps(step.elseSteps ?? [])]); }
const copy = (step: StepDefinition): StepDefinition => ({ ...structuredClone(step), stepId: crypto.randomUUID(), ...(step.children ? { children: step.children.map(copy) } : {}), ...(step.elseSteps ? { elseSteps: step.elseSteps.map(copy) } : {}) });
export function editSelectedSteps(steps: StepDefinition[], ids: string[], command: 'copy' | 'delete' | 'move', target = ''): StepDefinition[] {
  const selected = new Set(ids);
  const roots: StepDefinition[] = [];
  const collect = (items: StepDefinition[]) => { for (const step of items) { if (selected.has(step.stepId)) roots.push(step); else { collect(step.children ?? []); collect(step.elseSteps ?? []); } } };
  collect(steps);
  if (command === 'move' && roots.some(step => listSteps([step]).some(child => child.stepId === target.split(':')[0]))) throw new Error('不能移动到自身或自己的子步骤');
  const rootIds = new Set(roots.map(step => step.stepId));
  const rewrite = (items: StepDefinition[]): StepDefinition[] => items.flatMap(step => {
    if (rootIds.has(step.stepId)) return command === 'copy' ? [step, { ...copy(step), name: `${step.name} 副本` }] : [];
    return [{ ...step, ...(step.children ? { children: rewrite(step.children) } : {}), ...(step.elseSteps ? { elseSteps: rewrite(step.elseSteps) } : {}) }];
  });
  const next = rewrite(steps);
  if (command !== 'move') return next;
  if (!target) return [...next, ...roots];
  const [targetId, branch = 'children'] = target.split(':'); const owner = listSteps(next).find(step => step.stepId === targetId);
  if (!owner || !['control.if', 'control.forEach', 'control.forEachXlsx', 'control.tryCatch'].includes(owner.actionType) || !['children', 'elseSteps'].includes(branch) || branch === 'elseSteps' && ['control.forEach', 'control.forEachXlsx'].includes(owner.actionType)) throw new Error('请选择有效容器分支');
  const key = branch as 'children' | 'elseSteps'; owner[key] = [...(owner[key] ?? []), ...roots]; return next;
}
