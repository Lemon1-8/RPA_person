import { scheduleIdentifier, workflowSchema, type WorkflowDefinition } from '../../../packages/contracts/src/index.js';
import { validateActionParams, validateActions } from '../../../packages/actions/src/index.js';
import type { WorkbenchStore } from '../../../packages/persistence/src/workbench.js';
export async function workflowDependencies(store:WorkbenchStore, root:WorkflowDefinition):Promise<Record<string,WorkflowDefinition>> {
  return resolveWorkflowDependencies(root, (id, revision) => store.getRevision(id, revision));
}
export async function resolveWorkflowDependencies(root:WorkflowDefinition, load:(id:string,revision:number)=>Promise<WorkflowDefinition>):Promise<Record<string,WorkflowDefinition>> {
  const result:Record<string,WorkflowDefinition> = {};
  const visit = async (flow:WorkflowDefinition, ancestors:string[]) => {
    const key = `${flow.workflowId}@${flow.revision}`;
    if (ancestors.includes(key) || ancestors.some(item=>item.split('@')[0]===flow.workflowId)) throw new Error('子流程存在循环调用');
    if (ancestors.length>=20) throw new Error('子流程调用深度最多 20 层');
    validateActions(flow);
    const steps = [...flow.steps];
    while(steps.length) {
      const step = steps.shift()!; if(step.disabled) continue; steps.push(...step.children ?? [],...step.elseSteps ?? []);
      if(step.actionType!=='workflow.call') continue;
      const params = validateActionParams('workflow.call',{ ...step.params,inputs:{} }); const id=scheduleIdentifier.parse(params.workflowId); const revision=Number(params.revision);
      const child = workflowSchema.parse(await load(id,revision)); const childKey=`${id}@${revision}`;
      if (child.workflowId !== id || child.revision !== revision) throw new Error(`子流程修订不匹配：${childKey}`);
      if(ancestors.includes(childKey) || [...ancestors,key].some(item=>item.split('@')[0]===id)) throw new Error('子流程存在循环调用');
      if(!result[childKey]) { result[childKey]=child; await visit(child,[...ancestors,key]); }
    }
  };
  await visit(root,[]); return result;
}
