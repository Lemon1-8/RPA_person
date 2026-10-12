import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { transform } from 'esbuild';
import { workflowSchema, type WorkflowDefinition, type StepDefinition, type PreflightIssue } from '../../contracts/src/index.js';
import { getAction, validateActionParams, validateActions } from './index.js';

const references = (value: unknown): string[] => typeof value === 'string' ? [...value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(match => match[1].trim()) : value && typeof value === 'object' ? Object.values(value).flatMap(references) : [];
export async function preflight(input: WorkflowDefinition): Promise<PreflightIssue[]> {
  const issues: PreflightIssue[] = [];
  const parsed = workflowSchema.safeParse(input);
  if (!parsed.success) return parsed.error.issues.map(issue => ({ level: 'error', message: `${issue.path.join('.')}: ${issue.message}` }));
  const workflow = parsed.data;
  try { validateActions(workflow); } catch (error) { issues.push({ level: 'error', message: String(error) }); }
  const visit = async (steps: StepDefinition[], available: Set<string>, elements: Set<string>, conditional = false) => {
    for (const step of steps) {
      if (step.disabled || step.actionType === 'core.note') continue;
      const declared = new Set([...available, ...Object.keys(step.variables ?? {})]); const targets = new Set([...elements, ...Object.keys(step.elements ?? {}), ...Object.keys(step.desktopElements ?? {})]);
      const add = (level: 'error' | 'warning', message: string) => issues.push({ stepId: step.stepId, level, message });
      try {
        const action = getAction(step.actionType);
        const refs = step.actionType === 'script.run' ? [] : references({ ...step.params, progressKey: undefined });
        for (const ref of refs) if (![...declared].some(name => name === ref || ref.startsWith(`${name}.`))) add(available.has('__script_dynamic__')?'warning':'error', `变量尚未声明：${ref}${available.has('__script_dynamic__')?'，请确认前置脚本会产生该值':''}`);
        const params = { ...step.params };
        for (const field of action.metadata.fields) if (references(params[field.key]).length) {
          params[field.key] = field.type === 'number' ? 1 : field.type === 'json' ? action.metadata.defaults[field.key] ?? {} : field.type === 'boolean' ? true : '__runtime__';
        }
        // JSON arrays can contain runtime references, which are valid members.
        if (refs.length) add('warning', '含运行时变量，实际值会在执行前再次校验。');
        validateActionParams(step.actionType, params);
        if (typeof step.params.selector === 'string' && step.params.selector.startsWith('@') && !refs.length && !targets.has(step.params.selector.slice(1))) add('error', `元素引用不存在：${step.params.selector}`);
        if (['file.xlsxRead', 'control.forEachXlsx'].includes(step.actionType) && typeof step.params.path === 'string' && !references(step.params.path).length) await access(step.params.path).catch(() => add('error', '输入文件不存在或无法读取。'));
        if (step.actionType === 'script.run') {
          const language = step.params.language; const code = String(step.params.code ?? '');
          if (language !== 'python') await transform(code, { loader: language === 'typescript' ? 'ts' : 'js', format: 'esm' }).catch(error => add('error', `脚本语法错误：${String(error)}`));
          else {
            const executable = step.settings?.pythonExecutable ?? workflow.settings.pythonExecutable ?? 'python';
            await new Promise<void>(resolve => {
              const child = spawn(executable, ['-B', '-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['pipe', 'ignore', 'pipe'] });
              let message = ''; let done = false;
              const finish = (error?: string) => { if (done) return; done = true; clearTimeout(timer); if (error) add('error', error); resolve(); };
              const timer = setTimeout(() => { child.kill(); finish('Python 环境检查超时'); }, 5000);
              child.stderr.on('data', chunk => { message = (message + String(chunk)).slice(-2000); });
              child.on('error', () => finish('Python 解释器不可用，请检查可执行文件路径。'));
              child.on('close', code => finish(code ? `Python 语法检查失败：${message}` : undefined)); child.stdin.on('error', () => {}); child.stdin.end(code);
            });
          }
        }
      } catch (error) { add('error', String(error)); }
      const inside = new Set(declared); if (['control.forEach', 'control.forEachXlsx'].includes(step.actionType)) inside.add(String(step.params.itemVariable));
      await visit(step.children ?? [], inside, targets, true);
      const otherwise = new Set(declared); if (step.actionType === 'control.tryCatch') otherwise.add(String(step.params.errorVariable));
      await visit(step.elseSteps ?? [], otherwise, targets, true);
      await visit(step.recoveryChecks ?? [],new Set(declared),targets,true);
      for (const branchName of new Set([...inside, ...otherwise])) if (!declared.has(branchName) && branchName !== step.params.itemVariable && branchName !== step.params.errorVariable) { available.add(branchName); add('warning', `分支输出 ${branchName} 可能未产生。`); }
      if (step.output) available.add(step.output);
      if (step.actionType === 'variables.set' && typeof step.params.name === 'string') available.add(step.params.name);
      if (step.actionType === 'script.run') { available.add('__script_dynamic__');add('warning', '脚本可能动态读写变量；第三方依赖需在本地环境中自行准备。'); }
    }
  };
  await visit(workflow.steps, new Set([...Object.keys(workflow.variables),...workflow.inputs ?? []]), new Set([...Object.keys(workflow.elements), ...Object.keys(workflow.desktopElements ?? {})]));
  return issues;
}
