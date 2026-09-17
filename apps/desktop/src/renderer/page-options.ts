import type { BrowserPageInfo, ElementRef, StepDefinition, WorkflowDefinition } from '../../../../packages/contracts/src/index.js';

export interface PageOption {
  value: string;
  label: string;
  description: string;
  status: 'current' | 'open' | 'declared' | 'missing';
  sessionOnly: boolean;
}

export interface InheritedPageTarget {
  value: string;
  dynamic: boolean;
}

/** Reflect the dispatcher's element scope without replacing an inherited target in the saved flow. */
function resolvePageTarget(workflow: WorkflowDefinition, stepId: string, inheritOnly = false): InheritedPageTarget {
  const hasReference = (value: string) => /\{\{\s*[^{}]+?\s*\}\}/.test(value);
  const normalize = (value: unknown): InheritedPageTarget => ({
    value: typeof value === 'string' ? value.trim() || '$current' : String(value),
    dynamic: typeof value === 'string' && hasReference(value),
  });
  const target = (step: StepDefinition, elements: Record<string, ElementRef>): InheritedPageTarget => {
    const params = step.params;
    if (!inheritOnly && params.pageId !== undefined) return normalize(params.pageId);
    let element: unknown = params.element;
    if (typeof params.selector === 'string' && params.selector.startsWith('@')) {
      if (hasReference(params.selector)) return { value: '$current', dynamic: true };
      element = elements[params.selector.slice(1)];
    } else if (typeof params.selector === 'string' && /^\{\{\s*[^{}]+?\s*\}\}/.test(params.selector)) {
      // Runtime interpolation can produce @element, which takes priority over framePath.
      return { value: '$current', dynamic: true };
    } else if (params.framePath && typeof params.selector === 'string') {
      // dispatch builds a new element from selector/framePath and the explicit pageId here.
      element = undefined;
    }
    if (typeof element === 'string' && hasReference(element)) return { value: '$current', dynamic: true };
    const pageRef = element && typeof element === 'object' ? (element as { pageRef?: unknown }).pageRef : undefined;
    return normalize(pageRef === undefined ? '$current' : pageRef);
  };
  const visit = (steps: StepDefinition[], inherited: Record<string, ElementRef>): InheritedPageTarget | undefined => {
    for (const step of steps) {
      const elements = { ...inherited, ...step.elements };
      if (step.stepId === stepId) return target(step, elements);
      const result = visit(step.children ?? [], elements) ?? visit(step.elseSteps ?? [], elements);
      if (result !== undefined) return result;
    }
  };
  return visit(workflow.steps, workflow.elements) ?? { value: '$current', dynamic: false };
}

export function getEffectivePageTarget(workflow: WorkflowDefinition, stepId: string): string {
  return resolvePageTarget(workflow, stepId).value;
}

export function getInheritedPageTarget(workflow: WorkflowDefinition, stepId: string): InheritedPageTarget {
  return resolvePageTarget(workflow, stepId, true);
}

export interface BrowserPageError {
  stepId: string;
  stepName: string;
  error: string;
}

export function getBrowserPortMode(port: unknown): 'auto' | 'manual' {
  return port === undefined || port === 0 ? 'auto' : 'manual';
}

export function changeBrowserPortMode(params: Record<string, unknown>, mode: 'auto' | 'manual'): Record<string, unknown> {
  const next = { ...params };
  if (mode === 'auto') delete next.debugPort;
  else if (getBrowserPortMode(params.debugPort) === 'auto') next.debugPort = '';
  return next;
}

export function parseManualBrowserPort(value: string): number | string {
  const port = Number(value);
  // Retain incomplete/invalid input as a draft instead of turning a manually entered 0 into automatic mode.
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : value;
}

export function getBrowserPortError(port: unknown): string | undefined {
  const portVariable = typeof port === 'string' && /^\{\{\s*[^{}\s](?:[^{}]*[^{}\s])?\s*\}\}$/.test(port);
  if (port === undefined || port === 0 || portVariable
    || typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535) return undefined;
  return '手动指定的浏览器调试端口必须为 1024–65535 的整数；不需要指定时请选择自动分配。';
}

/** Validate saved browser fields across the complete tree, including unmounted inspector fields. */
export function getBrowserPageErrors(workflow: WorkflowDefinition): BrowserPageError[] {
  const errors: BrowserPageError[] = [];
  const aliasError = (value: unknown) => value === undefined || typeof value === 'string'
    ? getPageAliasError(value ?? '') : '网页别名必须是文本。';
  const visit = (steps: StepDefinition[]) => {
    for (const step of steps) {
      if (step.disabled) continue;
      const add = (error: string | undefined) => { if (error) errors.push({ stepId: step.stepId, stepName: step.name, error }); };
      if (step.actionType === 'browser.open') {
        if (typeof step.params.url !== 'string' || !step.params.url.trim()) add('请填写网页地址。');
        if (step.params.openMode === 'new') add(aliasError(step.params.pageId));
        add(getBrowserPortError(step.params.debugPort));
      }
      visit(step.children ?? []);
      visit(step.elseSteps ?? []);
    }
  };
  visit(workflow.steps);
  return errors;
}

/** Names declared anywhere in the flow are suggestions, not a promise that a branch has run. */
export function getDeclaredPageAliases(workflow: WorkflowDefinition): string[] {
  const aliases = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.trim() && value === value.trim()
      && value !== '$current' && !/[{}]/.test(value)) aliases.add(value);
  };
  const visit = (steps: StepDefinition[]) => {
    for (const step of steps) {
      if (step.disabled) continue;
      if (step.actionType === 'browser.open') add(step.params.pageId);
      visit(step.children ?? []);
      visit(step.elseSteps ?? []);
    }
  };
  visit(workflow.steps);
  return [...aliases];
}

export function getPageOptions(workflow: WorkflowDefinition, pages: BrowserPageInfo[], selectedValue?: string): PageOption[] {
  const declared = new Set(getDeclaredPageAliases(workflow));
  const live = new Map(pages.map(page => [page.pageId, page]));
  const current = pages.find(page => page.current);
  const aliases = new Set([...declared, ...live.keys()]);
  if (selectedValue && selectedValue !== '$current') aliases.add(selectedValue);
  const options: PageOption[] = [{
    value: '$current',
    label: '当前网页',
    description: current?.url ?? '使用流程选定的网页；手动切换浏览器标签不会改变此目标。',
    status: 'current', sessionOnly: false,
  }];
  for (const alias of aliases) {
    if (alias === '$current') continue;
    const page = live.get(alias);
    const sessionOnly = /^page-\d+$/.test(alias) && !declared.has(alias);
    options.push({
      value: alias,
      label: page
        ? sessionOnly ? `${page.title || '未命名网页'}（${alias}）` : `${alias}${page.title && page.title !== alias ? ` — ${page.title}` : ''}`
        : alias,
      description: page?.url ?? (declared.has(alias)
        ? '流程中声明的别名；请先执行打开此网页的步骤。'
        : '当前没有此别名的网页；请先打开或绑定该网页。'),
      status: page ? 'open' : declared.has(alias) ? 'declared' : 'missing',
      sessionOnly,
    });
  }
  return options;
}

export function getPageAliasError(value: string): string | undefined {
  if (!value.trim()) return '请填写新网页别名，例如 detail。';
  if (value !== value.trim()) return '网页别名不能包含首尾空格。';
  if (value === '$current') return '“$current”代表当前网页，请使用其他别名。';
  // Variable references are resolved by the engine before validating the final alias.
  if (/[{}]/.test(value.replace(/\{\{([^{}]+?)\}\}/g, (reference, name: string) => name.trim() ? '' : reference))) {
    return '花括号仅用于完整的变量引用，例如 {{pageName}}。';
  }
  return undefined;
}
