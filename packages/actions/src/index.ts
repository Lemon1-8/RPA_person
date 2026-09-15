import { z } from 'zod';
import { isAbsolute } from 'node:path';
import type { ActionDefinition, ActionField, StepDefinition, WorkflowDefinition } from '../../contracts/src/index.js';

const text = (key: string, label: string, required = true, placeholder?: string): ActionField => ({ key, label, type: 'text', required, placeholder });
const json = (key: string, label: string): ActionField => ({ key, label, type: 'json', required: true });
const selector = text('selector', '元素选择器', true, '#customer 或 @元素名称');
const page = text('pageId', '页面标识', false, 'main');
const fields = [selector, page];
const nonBlank = z.string().refine(value => value.trim().length > 0, '文本不可为空');
const framePath = z.array(nonBlank);
const elementRef = z.object({
  selector: nonBlank, pageRef: nonBlank.optional(), framePath: framePath.optional(), expectedCount: z.number().int().positive().optional(),
});
const target = { selector: nonBlank.optional(), element: elementRef.optional(), pageId: z.string().optional(), framePath: framePath.optional() };
const targetSchema = z.object(target).passthrough().refine(p => p.selector || p.element, '请设置元素选择器');
const downloadDirectory = z.string().refine(value => value === '' || (process.platform === 'win32'
  ? /^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/.test(value)
  : isAbsolute(value)), '下载目录必须为空或绝对路径；Windows 请填写盘符根路径或完整 UNC 共享路径');
const responseMethod = z.string().trim().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]*$/, '请求方法必须是单个 HTTP 方法名称').transform(value => value.toUpperCase());
const definitions: { metadata: ActionDefinition; schema: z.ZodType }[] = [];
function add(type: string, label: string, category: string, description: string, safeToRetry: boolean, actionFields: ActionField[], defaults: Record<string, unknown>, schema: z.ZodType) {
  definitions.push({ metadata: { type, label, category, description, safeToRetry, fields: actionFields, defaults }, schema });
}
add('browser.start', '启动浏览器', '浏览器', '为当前任务建立独立浏览器会话。', false, [], {}, z.object({}));
add('browser.open', '打开网页', '浏览器', '在当前任务的页面中打开网址。', false, [text('url', '网页地址', true, 'https://…'), page], { url: '', pageId: 'main' }, z.object({ url: z.string().url(), pageId: z.string().optional() }));
add('browser.wait', '等待元素', '网页操作', '等待元素出现，支持元素库与 iframe 路径。', true, fields, { selector: '' }, targetSchema);
add('browser.click', '点击元素', '网页操作', '重新定位并点击一个元素。', false, fields, { selector: '' }, targetSchema);
add('browser.fill', '输入文本', '网页操作', '填写输入框，支持 {{变量}}。', false, [...fields, text('value', '输入内容')], { selector: '', value: '' }, z.object({ ...target, value: z.string() }).refine(p => p.selector || p.element, '请设置元素选择器'));
add('browser.text', '读取文本', '数据采集', '读取元素文本，将结果写入输出变量。', true, fields, { selector: '' }, targetSchema);
add('browser.table', '读取表格', '数据采集', '提取表头和行内容。', true, fields, { selector: 'table' }, targetSchema);
add('browser.select', '选择下拉选项', '网页操作', '按值选择原生 select；自定义控件可用点击和校验组合。', false, [...fields, text('value', '选项值')], { selector: '', value: '' }, z.object({ ...target, value: z.string() }).refine(p => p.selector || p.element, '请设置元素选择器'));
add('browser.assertText', '校验页面文本', '校验', '等待页面出现期望文本，失败定位到当前步骤。', true, [...fields, text('text', '期望包含文本')], { selector: '', text: '' }, z.object({ ...target, text: z.string() }).refine(p => p.selector || p.element, '请设置元素选择器'));
add('browser.download', '点击并保存下载', '数据采集', '先监听下载再点击，保存成功后记录文件。同名文件自动加序号。', false,
  [...fields, text('directory', '保存目录', false, '留空使用流程设置'), text('filename', '文件名称', false, '订单-{{runId}}.csv')], { selector: '', directory: '', filename: '' }, z.object({ ...target, directory: downloadDirectory.optional(), filename: z.string().optional() }).refine(p => p.selector || p.element, '请设置元素选择器'));
add('browser.response', '点击并采集响应', '数据采集', '在点击前监听响应，可按网址、请求方法和请求内容关联。', false,
  [...fields, text('urlIncludes', '响应网址包含'), text('method', '请求方法', false, 'GET'), text('requestIncludes', '请求内容包含', false)], { selector: '', urlIncludes: '' }, z.object({ ...target, urlIncludes: nonBlank, method: responseMethod.optional(), requestIncludes: z.string().optional() }).refine(p => p.selector || p.element, '请设置元素选择器'));
add('script.run', '运行脚本', '脚本', '在独立进程运行本地脚本，通过 rpa 访问本任务的浏览器和变量。', false,
  [{ key: 'language', label: '脚本语言', type: 'select', required: true, options: [{ label: 'Python', value: 'python' }, { label: 'JavaScript', value: 'javascript' }, { label: 'TypeScript', value: 'typescript' }] }, { key: 'code', label: '脚本代码', type: 'textarea', required: true }],
  { language: 'python', code: 'from rpa_sdk import rpa\nrpa.output(rpa.get("runId"))' }, z.object({ language: z.enum(['python', 'javascript', 'typescript']), code: z.string().min(1) }));
add('variables.set', '设置变量', '流程控制', '设置一个 JSON 变量；完整 {{变量}} 引用保留原始类型。', true,
  [text('name', '变量名称'), json('value', '变量值（JSON）')], { name: 'result', value: '' }, z.object({ name: z.string().min(1), value: z.unknown() }));
add('core.assert', '校验结果', '校验', '比较两个 JSON 值是否相等。', true,
  [json('actual', '实际值（JSON）'), json('expected', '期望值（JSON）')], { actual: '{{result}}', expected: '' }, z.object({ actual: z.unknown(), expected: z.unknown() }));
add('control.if', '条件分支', '流程控制', '满足条件执行子步骤，否则执行另一分支。', false,
  [json('left', '左值（JSON）'), { key: 'operator', label: '比较方式', type: 'select', options: [{ label: '等于', value: 'equals' }, { label: '不等于', value: 'notEquals' }, { label: '为真', value: 'truthy' }], required: true }, json('right', '右值（JSON）')],
  { left: true, operator: 'truthy', right: null }, z.object({ left: z.unknown(), operator: z.enum(['equals', 'notEquals', 'truthy']), right: z.unknown().optional() }));
add('control.forEach', '遍历列表', '流程控制', '逐项执行子步骤，循环结束恢复同名变量。最多 10000 项。', false,
  [json('items', '列表或变量引用（JSON）'), text('itemVariable', '当前项变量')], { items: [], itemVariable: 'item' }, z.object({ items: z.array(z.unknown()).max(10_000), itemVariable: z.string().min(1) }));

export const actionDefinitions: ActionDefinition[] = definitions.map(d => d.metadata);
export function getAction(type: string) {
  const found = definitions.find(d => d.metadata.type === type);
  if (!found) throw new Error(`不支持的动作：${type}`);
  return found;
}
export function validateActionParams(type: string, params: Record<string, unknown>): Record<string, unknown> {
  const result = getAction(type).schema.safeParse(params);
  if (!result.success) throw new Error(`${getAction(type).metadata.label} 参数错误：${result.error.issues.map(i => i.message).join('；')}`);
  return result.data as Record<string, unknown>;
}
export function validateActions(workflow: WorkflowDefinition) {
  const visit = (steps: StepDefinition[]) => {
    for (const step of steps) {
      const action = getAction(step.actionType);
      if (!action.metadata.safeToRetry && (step.retry?.maxAttempts ?? 1) > 1) throw new Error(`“${step.name}”有外部效果，当前版本不允许自动重试。`);
      if (!action.metadata.safeToRetry && step.onError === 'pause') throw new Error(`“${step.name}”有外部效果，当前版本仅支持读取和校验动作失败后暂停。`);
      if (!['control.if', 'control.forEach'].includes(step.actionType) && ((step.children?.length ?? 0) || (step.elseSteps?.length ?? 0))) throw new Error(`“${step.name}”不是容器动作，不能包含子步骤。`);
      if (step.actionType === 'control.forEach' && step.elseSteps?.length) throw new Error('循环不支持否则分支');
      visit(step.children ?? []); visit(step.elseSteps ?? []);
    }
  }; visit(workflow.steps);
}
