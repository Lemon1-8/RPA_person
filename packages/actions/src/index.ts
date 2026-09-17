import { z } from 'zod';
import { isAbsolute } from 'node:path';
import type { ActionDefinition, ActionField, StepDefinition, WorkflowDefinition } from '../../contracts/src/index.js';

const text = (key: string, label: string, required = true, placeholder?: string): ActionField => ({ key, label, type: 'text', required, placeholder });
const json = (key: string, label: string): ActionField => ({ key, label, type: 'json', required: true });
const selector = text('selector', '元素选择器', true, '#customer 或 @元素名称');
const page = text('pageId', '目标网页', false, '当前网页');
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
const browserStartup = {
  browserChannel: z.enum(['auto', 'chrome', 'msedge', 'chromium']).optional(),
  debugPort: z.number().int('调试端口必须为整数').refine(port => port === 0 || (port >= 1024 && port <= 65535), '调试端口必须为 0 或 1024–65535 的整数').optional(),
};
const browserStartupFields: ActionField[] = [
  { key: 'browserChannel', label: '浏览器', type: 'select', required: true, options: [{ label: '自动选择本机 Chrome / Edge', value: 'auto' }, { label: 'Google Chrome', value: 'chrome' }, { label: 'Microsoft Edge', value: 'msedge' }, { label: 'Chromium（测试用）', value: 'chromium' }] },
  { key: 'debugPort', label: '调试端口（0 自动分配）', type: 'number', required: false, placeholder: '0' },
];
const definitions: { metadata: ActionDefinition; schema: z.ZodType }[] = [];
function add(type: string, label: string, category: string, description: string, safeToRetry: boolean, actionFields: ActionField[], defaults: Record<string, unknown>, schema: z.ZodType) {
  definitions.push({ metadata: { type, label, category, description, safeToRetry, fields: actionFields, defaults }, schema });
}
add('browser.start', '启动浏览器', '浏览器', '启动本机 Chrome 或 Edge，通过独立调试端口连接。', false,
  browserStartupFields, { browserChannel: 'auto', debugPort: 0 }, z.object(browserStartup));
add('browser.open', '打开网页', '浏览器', '首次自动启动浏览器，后续复用；可在已有标签页打开或新建网页。', false,
  [text('url', '网页地址', true, 'https://…'), { key: 'openMode', label: '打开方式', type: 'select', options: [{ label: '在已有标签页打开', value: 'reuse' }, { label: '新建标签页', value: 'new' }] }, page, ...browserStartupFields],
  { url: '', openMode: 'reuse', pageId: '$current' }, z.object({ url: z.string().url(), pageId: z.string().optional(), openMode: z.enum(['reuse', 'new']).optional(), ...browserStartup }));
add('browser.switchPage', '切换网页', '浏览器', '按网页别名切换后续指令的目标；不会重新加载页面。', true,
  [page], { pageId: 'main' }, z.object({ pageId: z.string().optional() }));
add('browser.closePage', '关闭网页', '浏览器', '关闭指定标签页。后续步骤请选择仍打开的目标网页。', false,
  [page], { pageId: '$current' }, z.object({ pageId: z.string().optional() }));
add('browser.popupGuard', '智能屏蔽弹窗', '浏览器', '为当前浏览器持续屏蔽广告、营销、Cookie 弹层和意外新窗口；登录、支付及业务确认弹层保留。', true,
  [{ key: 'mode', label: '屏蔽模式', type: 'select', required: true, options: [{ label: '智能屏蔽（推荐）', value: 'smart' }, { label: '严格屏蔽', value: 'strict' }, { label: '关闭屏蔽', value: 'off' }] }],
  { mode: 'smart' }, z.object({ mode: z.enum(['off', 'smart', 'strict']) }));
add('browser.wait', '等待元素', '网页操作', '等待元素出现，支持元素库与 iframe 路径。', true, fields, { selector: '' }, targetSchema);
add('browser.click', '点击元素', '网页操作', '在当前或指定的目标网页点击元素。', false,
  fields, { selector: '' }, z.object(target).refine(p => p.selector || p.element, '请设置元素选择器'));
add('browser.fill', '输入文本', '网页操作', '填写输入框，支持 {{变量}}。', false, [...fields, text('value', '输入内容')], { selector: '', value: '' }, z.object({ ...target, value: z.string() }).refine(p => p.selector || p.element, '请设置元素选择器'));
add('browser.text', '读取文本', '数据采集', '读取元素文本，将结果写入输出变量。', true, fields, { selector: '' }, targetSchema);
add('browser.table', '读取表格', '数据采集', '提取表头和行内容。', true, fields, { selector: 'table' }, targetSchema);
add('browser.select', '选择下拉选项', '网页操作', '按值选择原生 select；自定义控件可用点击和校验组合。', false, [...fields, text('value', '选项值')], { selector: '', value: '' }, z.object({ ...target, value: z.string() }).refine(p => p.selector || p.element, '请设置元素选择器'));
add('browser.assertText', '校验页面文本', '校验', '等待页面出现期望文本，失败定位到当前步骤。', true, [...fields, text('text', '期望包含文本')], { selector: '', text: '' }, z.object({ ...target, text: z.string() }).refine(p => p.selector || p.element, '请设置元素选择器'));
add('browser.download', '点击并保存下载', '数据采集', '先监听下载再点击，保存成功后记录文件。同名文件自动加序号。', false,
  [...fields, text('directory', '保存目录', false, '留空使用流程设置'), text('filename', '文件名称', false, '订单导出.csv')], { selector: '', directory: '', filename: '' }, z.object({ ...target, directory: downloadDirectory.optional(), filename: z.string().optional() }).refine(p => p.selector || p.element, '请设置元素选择器'));
add('browser.response', '点击并采集响应', '数据采集', '在点击前监听响应，可按网址、请求方法和请求内容关联。', false,
  [...fields, text('urlIncludes', '响应网址包含'), text('method', '请求方法', false, 'GET'), text('requestIncludes', '请求内容包含', false)], { selector: '', urlIncludes: '' }, z.object({ ...target, urlIncludes: nonBlank, method: responseMethod.optional(), requestIncludes: z.string().optional() }).refine(p => p.selector || p.element, '请设置元素选择器'));
add('script.run', '运行脚本', '脚本', '在独立进程运行本地脚本，通过 rpa 访问本任务的浏览器和变量。', false,
  [{ key: 'language', label: '脚本语言', type: 'select', required: true, options: [{ label: 'Python', value: 'python' }, { label: 'JavaScript', value: 'javascript' }, { label: 'TypeScript', value: 'typescript' }] }, { key: 'code', label: '脚本代码', type: 'textarea', required: true }],
  { language: 'python', code: 'from rpa_sdk import rpa\nrpa.output("脚本执行完成")' }, z.object({ language: z.enum(['python', 'javascript', 'typescript']), code: z.string().min(1) }));
add('variables.set', '设置变量', '流程控制', '设置一个 JSON 变量；完整 {{变量}} 引用保留原始类型。', true,
  [text('name', '变量名称'), json('value', '变量值（JSON）')], { name: 'result', value: '' }, z.object({ name: z.string().min(1), value: z.unknown() }));
add('core.log', '打印日志', '流程控制', '将文字或变量值写入下方运行日志。放在循环体中可逐项查看当前值，无需打开浏览器。', true,
  [{ key: 'message', label: '日志内容', type: 'textarea', required: true, placeholder: '例如：当前项：{{item}}；也可点击下方「插入变量」' }],
  { message: '' }, z.object({ message: z.json() }));
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
  const action = getAction(type);
  const result = action.schema.safeParse(params);
  if (!result.success) throw new Error(`${action.metadata.label} 参数错误：${result.error.issues.map(issue => {
    const key = issue.path[0];
    const label = action.metadata.fields.find(field => field.key === key)?.label ?? (key ? String(key) : '参数');
    if (issue.code === 'invalid_type') {
      const value = issue.path.reduce<unknown>((parent, part) => parent && typeof parent === 'object' ? (parent as Record<PropertyKey, unknown>)[part] : undefined, params);
      if (key === 'pageId' && value && typeof value === 'object' && !Array.isArray(value)) {
        return `${label}必须是文本，不能使用整个对象；请引用其中的网页名称，例如 {{变量.pageId}}`;
      }
      const expected = ({ string: '文本', boolean: '开关值', number: '数字', array: '列表', object: '对象' } as Record<string, string>)[issue.expected] ?? '有效值';
      const received = value === undefined ? '未填写' : value === null ? '空值' : Array.isArray(value) ? '列表' : ({ string: '文本', boolean: '开关值', number: '数字', object: '对象' } as Record<string, string>)[typeof value] ?? '其他类型';
      return `${label}必须是${expected}，当前为${received}`;
    }
    return issue.path.length ? `${label}：${issue.message}` : issue.message;
  }).join('；')}`);
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
