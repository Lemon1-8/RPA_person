import type { DesktopElementRef, StepDefinition, WorkflowDefinition } from '../../../../packages/contracts/src/index.js';

// Only direct windows.call arguments are references. A same-named web selector,
// input text or dynamically assembled selector must not be rewritten.
function desktopScriptReferences(code: string, oldName: string, name?: string) {
  const expression = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g;
  const tokens = [...code.matchAll(expression)].filter(token => !token[0].startsWith('//') && !token[0].startsWith('/*') && !token[0].startsWith('#'));
  const literal = (value: string) => {
    if (value.startsWith('"')) { try { return JSON.parse(value) as string; } catch { return undefined; } }
    if (value.startsWith("'")) return value.slice(1, -1).replace(/\\(['"\\])/g, '$1');
    return undefined;
  };
  const references = new Map<number, RegExpMatchArray>();
  for (let index = 0; index + 6 < tokens.length; index++) {
    const words = tokens.slice(index, index + 7).map(token => token[0]);
    if (words[0] !== 'rpa' || words[1] !== '.' || words[2] !== 'call' || words[3] !== '(' || !literal(words[4])?.startsWith('windows.') || words[5] !== ',' || words[6] !== '{') continue;
    let depth = 1;
    for (let cursor = index + 7; cursor < tokens.length && depth > 0; cursor++) {
      const value = tokens[cursor][0];
      if (value === '{') depth++; else if (value === '}') depth--;
      else if (depth === 1 && (value === 'selector' || literal(value) === 'selector') && tokens[cursor + 1]?.[0] === ':' && literal(tokens[cursor + 2]?.[0] ?? '') === '@' + oldName) {
        const token = tokens[cursor + 2]; references.set(token.index!, token);
      }
    }
  }
  let result = code;
  if (name) for (const [position, token] of [...references].sort(([a], [b]) => b - a)) {
    const replacement = token[0][0] === '"' ? JSON.stringify('@' + name) : "'" + ('@' + name).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
    result = result.slice(0, position) + replacement + result.slice(position + token[0].length);
  }
  return { count: references.size, code: result };
}

export function inheritedDesktopElements(workflow: WorkflowDefinition, stepId?: string): Record<string, DesktopElementRef> {
  let result = workflow.desktopElements ?? {};
  const visit = (steps: StepDefinition[], inherited: Record<string, DesktopElementRef>): boolean => {
    for (const step of steps) {
      const current = { ...inherited, ...step.desktopElements };
      if (step.stepId === stepId) { result = current; return true; }
      if (visit(step.children ?? [], current) || visit(step.elseSteps ?? [], current) || visit(step.recoveryChecks ?? [], current)) return true;
    }
    return false;
  };
  if (stepId) visit(workflow.steps, result);
  return result;
}

export function changeDesktopElement(workflow: WorkflowDefinition, ownerId: string | undefined, oldName: string | undefined, name: string | undefined, element?: DesktopElementRef): WorkflowDefinition {
  const next = structuredClone(workflow);
  const owners: StepDefinition[] = [];
  const find = (steps: StepDefinition[]) => { for (const step of steps) { owners.push(step); find(step.children ?? []); find(step.elseSteps ?? []); find(step.recoveryChecks ?? []); } };
  find(next.steps);
  const owner = ownerId ? owners.find(step => step.stepId === ownerId) : next;
  if (!owner) throw new Error('元素所属指令不存在');
  const library = owner.desktopElements ?? {};
  if (name && name !== oldName && Object.hasOwn(library, name)) throw new Error(`元素名称已存在：${name}`);
  const references: string[] = [];
  const visit = (steps: StepDefinition[], binding?: string, newBinding?: string, trail: string[] = []) => {
    for (const step of steps) {
      const current = oldName && Object.hasOwn(step.desktopElements ?? {}, oldName) ? step.stepId : binding;
      const renamedBinding = name && (step.stepId === ownerId || Object.hasOwn(step.desktopElements ?? {}, name)) ? step.stepId : newBinding;
      const position = [...trail, step.name];
      const record = () => {
        if (name && name !== oldName && renamedBinding !== ownerId) throw new Error(`新名称在 ${position.join(' > ')} 中被局部元素覆盖，请使用其他名称`);
        references.push(position.join(' > ') + `（${step.stepId}）`);
      };
      if (oldName && current === ownerId) {
        if (step.actionType.startsWith('windows.') && step.params.selector === '@' + oldName) {
          record(); if (name) step.params.selector = '@' + name;
        }
        if (step.actionType === 'script.run' && typeof step.params.code === 'string') {
          const script = desktopScriptReferences(step.params.code, oldName, name);
          if (script.count) { record(); if (name) step.params.code = script.code; }
        }
      }
      visit(step.children ?? [], current, renamedBinding, position); visit(step.elseSteps ?? [], current, renamedBinding, position);
      visit(step.recoveryChecks ?? [], current, renamedBinding, position);
    }
  };
  visit(next.steps);
  if (!name && references.length) throw new Error('元素正在被这些指令引用：' + [...new Set(references)].join('、'));
  if (oldName) delete library[oldName];
  if (name && element) library[name] = element;
  owner.desktopElements = library;
  return next;
}
