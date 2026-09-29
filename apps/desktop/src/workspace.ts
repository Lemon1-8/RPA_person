import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { StepDefinition, WorkflowDefinition } from '../../../packages/contracts/src/index.js';
import { writeJsonAtomic } from '../../../packages/persistence/src/index.js';
import type { RunManager } from '../../runner/src/manager.js';

/** Keep an intentionally empty workspace empty after the first desktop launch. */
export async function seedDesktopWorkspace(manager: RunManager, demo: WorkflowDefinition) {
  const marker = join(manager.store.directory, 'desktop-initialized.json');
  try { await access(marker); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!(await manager.listWorkflows()).length) await manager.saveWorkflow(demo);
  await writeJsonAtomic(marker, { initializedAt: new Date().toISOString() });
}

function isFixtureUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(value)) return false;
  try { return !!new URL(value).port; } catch { return false; }
}

function visitSteps(steps: StepDefinition[], visit: (step: StepDefinition, scoped: Set<string>) => void, inherited = new Set<string>()) {
  for (const step of steps) {
    const scoped = new Set([...inherited, ...Object.keys(step.variables ?? {})]);
    visit(step, scoped);
    const childrenScope = new Set(scoped);
    if (['control.forEach', 'control.forEachXlsx'].includes(step.actionType) && typeof step.params.itemVariable === 'string') childrenScope.add(step.params.itemVariable);
    visitSteps(step.children ?? [], visit, childrenScope);
    const catchScope = new Set(scoped);
    if (step.actionType === 'control.tryCatch' && typeof step.params.errorVariable === 'string') catchScope.add(step.params.errorVariable);
    visitSteps(step.elseSteps ?? [], visit, catchScope);
  }
}

function hasGlobalWrite(steps: StepDefinition[], name: string, inheritedShadow = false): boolean {
  return steps.some(step => {
    if (step.actionType === 'core.note') return false;
    const shadow = inheritedShadow || Object.hasOwn(step.variables ?? {}, name);
    // Outputs are published after restoring the step's own local declarations.
    if (step.output === name && !inheritedShadow) return true;
    if (step.actionType === 'variables.set' && !shadow && (step.params.name === name
      || (typeof step.params.name === 'string' && /\{\{[^{}]+\}\}/.test(step.params.name)))) return true;
    return hasGlobalWrite(step.children ?? [], name, shadow || (['control.forEach', 'control.forEachXlsx'].includes(step.actionType) && step.params.itemVariable === name))
      || hasGlobalWrite(step.elseSteps ?? [], name, shadow || (step.actionType === 'control.tryCatch' && step.params.errorVariable === name));
  });
}

/** Constants can be inlined; explicitly assigned business variables retain their initial value. */
function removeDemoDefault(workflow: WorkflowDefinition, name: 'demoUrl' | 'customer', value: string): boolean {
  if (hasGlobalWrite(workflow.steps, name)) return false;
  const reference = new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'g');
  const replace = <T>(entry: T): T => {
    if (typeof entry === 'string') return entry.replace(reference, () => value) as T;
    if (Array.isArray(entry)) return entry.map(replace) as T;
    if (entry && typeof entry === 'object') return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, replace(item)])) as T;
    return entry;
  };
  const hasReference = (entry: unknown): boolean => {
    if (typeof entry === 'string') return new RegExp(reference.source).test(entry);
    if (Array.isArray(entry)) return entry.some(hasReference);
    return !!entry && typeof entry === 'object' && Object.values(entry).some(hasReference);
  };
  const rewriteSteps = (steps: StepDefinition[], inheritedElements: WorkflowDefinition['elements'], inheritedShadow = false) => {
    for (const step of steps) {
      const originalOwnElements = step.elements;
      const originalElements = { ...inheritedElements, ...originalOwnElements };
      const shadow = inheritedShadow || Object.hasOwn(step.variables ?? {}, name);
      if (!shadow) {
        // Script source is literal code, never a template. Custom SDK reads must
        // supply their own variables after removal of these example declarations.
        if (!['script.run', 'core.note'].includes(step.actionType)) step.params = replace(step.params);
        if (step.elements) step.elements = replace(step.elements);
      } else {
        // The shared declaration was inlined outside this scope. Restore the
        // effective original templates where a local/loop binding must win.
        const inheritedTemplates = Object.fromEntries(Object.entries(originalElements).filter(([, element]) => hasReference(element)));
        if (Object.keys(inheritedTemplates).length) step.elements = { ...inheritedTemplates, ...originalOwnElements };
      }
      rewriteSteps(step.children ?? [], originalElements, shadow || (['control.forEach', 'control.forEachXlsx'].includes(step.actionType) && step.params.itemVariable === name));
      rewriteSteps(step.elseSteps ?? [], originalElements, shadow || (step.actionType === 'control.tryCatch' && step.params.errorVariable === name));
    }
  };
  const originalElements = workflow.elements;
  workflow.elements = replace(originalElements);
  rewriteSteps(workflow.steps, originalElements);
  delete workflow.variables[name];
  return true;
}

/** Refresh the built-in fixture's port and migrate its former example variables. */
export async function refreshDemoUrls(manager: RunManager, demoUrl: string) {
  for (const workflow of await manager.listWorkflows()) {
    if (workflow.workflowId !== 'order-export-demo') continue;
    let changed = false;
    if (isFixtureUrl(workflow.variables.demoUrl)) {
      if (removeDemoDefault(workflow, 'demoUrl', demoUrl)) changed = true;
      else if (workflow.variables.demoUrl !== demoUrl) { workflow.variables.demoUrl = demoUrl; changed = true; }
    }
    if (workflow.variables.customer === '跨语言订单') changed = removeDemoDefault(workflow, 'customer', '跨语言订单') || changed;
    visitSteps(workflow.steps, step => {
      if (step.stepId === 'open' && step.actionType === 'browser.open' && isFixtureUrl(step.params.url) && step.params.url !== demoUrl) {
        step.params.url = demoUrl; changed = true;
      }
    });
    if (changed) await manager.saveWorkflow(workflow);
  }
}
