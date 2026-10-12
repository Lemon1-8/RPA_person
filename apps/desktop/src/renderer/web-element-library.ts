import type { ElementRef, StepDefinition, WorkflowDefinition } from '../../../../packages/contracts/src/index.js';

function visitElements(steps: StepDefinition[], key: string, ownerId: string | undefined, callback: (step: StepDefinition, visible: boolean) => void, binding?: string) {
  for (const step of steps) {
    const current = step.stepId === ownerId || Object.hasOwn(step.elements ?? {}, key) ? step.stepId : binding;
    callback(step, current === ownerId);
    for (const children of [step.children, step.elseSteps, step.recoveryChecks]) visitElements(children ?? [], key, ownerId, callback, current);
  }
}

export function webElementReferences(workflow: WorkflowDefinition, ownerId: string | undefined, key: string) {
  const references: { stepId: string; name: string; script: boolean }[] = [];
  visitElements(workflow.steps, key, ownerId, (step, visible) => {
    if (!visible) return;
    const script = step.actionType === 'script.run' && String(step.params.code).includes(`@${key}`);
    if (script || step.actionType.startsWith('browser.') && step.params.selector === `@${key}`) references.push({ stepId: step.stepId, name: step.name, script });
  });
  return references;
}

export function changeWebElement(workflow: WorkflowDefinition, ownerId: string | undefined, key: string, name: string, element: ElementRef, selectedId?: string): WorkflowDefinition {
  const next = structuredClone(workflow);
  let owner: WorkflowDefinition | StepDefinition | undefined = ownerId ? undefined : next;
  visitElements(next.steps, key, ownerId, step => { if (step.stepId === ownerId) owner = step; });
  if (!owner) throw new Error('元素所属指令不存在');
  const library = { ...owner.elements };
  if (name !== key && Object.hasOwn(library, name)) throw new Error('元素名称已存在');
  const creating = !Object.hasOwn(library, key);
  const visit = (steps: StepDefinition[], binding?: string, renamedBinding?: string) => {
    for (const step of steps) {
      const current = step.stepId === ownerId || Object.hasOwn(step.elements ?? {}, key) ? step.stepId : binding;
      const renamed = step.stepId === ownerId || Object.hasOwn(step.elements ?? {}, name) ? step.stepId : renamedBinding;
      if (current === ownerId && step.actionType.startsWith('browser.')) {
        if (step.params.selector === `@${key}` && key !== name) {
          if (renamed !== ownerId) throw new Error(`新名称在 ${step.name} 中被局部元素覆盖，请使用其他名称`);
          step.params.selector = `@${name}`;
        } else if (creating && step.stepId === selectedId && Object.hasOwn(step.params, 'selector')) step.params.selector = `@${name}`;
      }
      for (const children of [step.children, step.elseSteps, step.recoveryChecks]) visit(children ?? [], current, renamed);
    }
  };
  visit(next.steps);
  delete library[key]; library[name] = element; owner.elements = library;
  return next;
}
