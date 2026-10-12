import { z } from 'zod';
import { isAbsolute } from 'node:path';
import type { ActionDefinition, ActionField, StepDefinition, WorkflowDefinition } from '../../contracts/src/index.js';
import { browserScreenshotParamsSchema, desktopElementSchema, desktopWindowSchema, desktopAttributeNames, desktopMatchSchema } from '../../contracts/src/index.js';

const text = (key: string, label: string, required = true, placeholder?: string): ActionField => ({ key, label, type: 'text', required, placeholder });
const json = (key: string, label: string): ActionField => ({ key, label, type: 'json', required: true });
const number = (key: string, label: string, required = true, placeholder?: string): ActionField => ({ key, label, type: 'number', required, placeholder });
const selector = text('selector', '元素选择器', true, '#customer 或 @元素名称');
const page = text('pageId', '目标网页', false, '当前网页');
const fields = [selector, page];
const clickMode: ActionField = {
  key: 'clickMode', label: '点击方式', type: 'select', required: true,
  options: [
    { label: '标准点击', value: 'normal' },
    { label: '强制点击', value: 'force' },
    { label: 'DOM 点击', value: 'dom' },
  ],
};
const nonBlank = z.string().refine(value => value.trim().length > 0, '文本不可为空');
const finiteNumber = z.number().finite();
const humanMouse = { humanLike: z.boolean().optional() };
const typingOptions = { inputMode: z.enum(['type', 'paste']).optional(), simulateTypo: z.boolean().optional(), typoText: z.string().max(20).optional() };
const clickModeSchema = z.union([z.enum(['normal', 'force', 'dom']), z.literal('').transform(() => 'normal')]).optional();
const framePath = z.array(nonBlank);
const elementRef = z.object({
  selector: nonBlank, pageRef: nonBlank.optional(), framePath: framePath.optional(), expectedCount: z.number().int().positive().optional(),
});
const target = { selector: nonBlank.optional(), element: elementRef.optional(), pageId: z.string().optional(), framePath: framePath.optional() };
const targetSchema = z.object(target).passthrough().refine(p => p.selector || p.element, '请设置元素选择器');
const downloadDirectory = z.string().refine(value => value === '' || (process.platform === 'win32'
  ? /^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/.test(value)
  : isAbsolute(value)), '下载目录必须为空或绝对路径；Windows 请填写盘符根路径或完整 UNC 共享路径');
const absoluteFilePath = z.string().refine(value => process.platform === 'win32'
  ? /^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/.test(value)
  : isAbsolute(value), '文件路径必须是完整绝对路径；Windows 请填写盘符根路径或完整 UNC 共享路径');
const xlsxFilePath = absoluteFilePath.refine(value => /\.xlsx$/i.test(value), '文件路径必须以 .xlsx 结尾');
const sheetName = z.string().refine(value => value === '' || (value.trim() === value && value.length <= 31 && !/[:\\/?*\[\]]/.test(value)), '工作表名称不能包含首尾空格、: \\ / ? * [ ]，且最多 31 个字符');
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
const windowsTarget = { selector: z.string().regex(/^@.+$/, '请从桌面元素库选择目标').optional(), element: desktopElementSchema.optional() };
const windowsFields = [text('selector', '桌面目标元素', true, '@元素名称')];
const windowsSchema = <T extends z.ZodRawShape>(extra: T = {} as T) => z.object({ ...windowsTarget, ...extra }).refine(p => {
  const target = p as { selector?: unknown; element?: unknown };
  return target.selector || target.element;
}, '请设置桌面目标元素');
const windowsMode: ActionField = { key: 'mode', label: '操作方式', type: 'select', options: [{ label: '控件接口', value: 'api' }, { label: '模拟操作（占用真实键鼠）', value: 'simulate' }] };
const windowsCategory = '桌面软件自动化';
add('windows.findWindow', '获取软件窗口', windowsCategory, '按进程名称、标题及类名获取唯一窗口，输出窗口的定位引用与属性。标题支持 * 通配符。', true,
  [text('processName', '进程名称', false, '不含 .exe'), text('title', '窗口标题', false), text('className', '窗口类名', false)], { processName: '', title: '', className: '' },
  z.object({ processName: z.string().optional(), title: z.string().optional(), className: z.string().optional(), window: desktopWindowSchema.optional() }).refine(p => p.window || p.processName || p.title || p.className, '请设置至少一个窗口条件').transform(p => ({ window: p.window ?? Object.fromEntries(['processName', 'title', 'className'].filter(k => p[k as keyof typeof p]).map(k => [k, { value: p[k as keyof typeof p], match: k === 'title' && String(p.title).includes('*') ? 'wildcard' : 'exact' }])) })));
for (const [method, label, description] of [
  ['find', '获取软件元素', '获取元素的定位引用、属性及位置。'],
  ['text', '读取软件文本', '优先读取文本接口、值接口，最后读取元素名称。'],
  ['bounds', '获取软件元素位置', '输出物理屏幕像素坐标 x、y、width、height。'],
  ['exists', '判断软件元素存在', '存在返回 true；未找到返回 false；歧义和系统错误仍报错。'],
] as const) add(`windows.${method}`, label, windowsCategory, description, true, windowsFields, { selector: '' }, windowsSchema());
add('windows.click', '点击软件元素', windowsCategory, '默认通过 Invoke 接口单击；不支持时可选择模拟操作，先激活目标窗口再使用真实鼠标。', false, [...windowsFields, windowsMode], { selector: '', mode: 'api' }, windowsSchema({ mode: z.enum(['api', 'simulate']).default('api') }));
add('windows.fill', '填写软件输入框', windowsCategory, '默认通过 Value 接口填写；可选择模拟操作。覆盖输入或追加文字，支持变量。', false, [...windowsFields, windowsMode, text('value', '输入内容'), { key: 'append', label: '追加输入', type: 'boolean' }], { selector: '', mode: 'api', value: '', append: false }, windowsSchema({ mode: z.enum(['api', 'simulate']).default('api'), value: z.string(), append: z.boolean().default(false) }));
add('windows.getAttribute', '读取软件元素属性', windowsCategory, '读取 UIA 控件属性。', true, [...windowsFields, { key: 'name', label: '属性', type: 'select', options: desktopAttributeNames.map(value => ({ label: value, value })) }], { selector: '', name: 'Name' }, windowsSchema({ name: z.enum(desktopAttributeNames) }));
add('windows.wait', '等待软件元素', windowsCategory, '等待元素存在、可见或消失，遵守当前步骤超时。', true, [...windowsFields, { key: 'state', label: '等待状态', type: 'select', options: [{ label: '可见', value: 'visible' }, { label: '存在', value: 'exists' }, { label: '消失', value: 'gone' }] }], { selector: '', state: 'visible' }, windowsSchema({ state: z.enum(['visible', 'exists', 'gone']).default('visible') }));
add('windows.check', '设置软件复选框', windowsCategory, '通过 Toggle 接口设置复选框的选中状态。', false, [...windowsFields, { key: 'checked', label: '选中', type: 'boolean' }], { selector: '', checked: true }, windowsSchema({ checked: z.boolean() }));
add('windows.select', '选择软件下拉选项', windowsCategory, '通过展开和选择接口设置下拉框；选项文字必须匹配唯一项。', false, [...windowsFields, text('item', '选项文字'), { key: 'match', label: '匹配方式', type: 'select', options: [{ label: '精确', value: 'exact' }, { label: '通配符', value: 'wildcard' }] }], { selector: '', item: '', match: 'exact' }, windowsSchema({ item: z.union([nonBlank, desktopMatchSchema]), match: z.enum(['exact', 'wildcard']).default('exact') }).transform(p => ({ ...p, item: typeof p.item === 'string' ? { value: p.item, match: p.match } : p.item })));
add('windows.related', '获取软件关联元素', windowsCategory, '获取父元素、所有子元素、指定子元素或前后相邻元素；返回可复用的结构化定位引用。', true, [...windowsFields, { key: 'relation', label: '关联方式', type: 'select', options: [{ label: '父元素', value: 'parent' }, { label: '所有子元素', value: 'children' }, { label: '指定子元素', value: 'child' }, { label: '前一个相邻元素', value: 'previous' }, { label: '后一个相邻元素', value: 'next' }] }, number('index', '子元素序号（从 0 开始）')], { selector: '', relation: 'parent', index: 0 }, windowsSchema({ relation: z.enum(['parent', 'children', 'child', 'previous', 'next']), index: z.number().int().nonnegative().default(0) }));
add('browser.start', '启动浏览器', '浏览器', '启动本机 Chrome 或 Edge，通过独立调试端口连接。', false,
  browserStartupFields, { browserChannel: 'auto', debugPort: 0 }, z.object(browserStartup));
add('browser.open', '打开网页', '浏览器', '首次自动启动浏览器，后续复用；可在已有标签页打开或新建网页。', false,
  [text('url', '网页地址', true, 'https://…'), { key: 'openMode', label: '打开方式', type: 'select', options: [{ label: '在已有标签页打开', value: 'reuse' }, { label: '新建标签页', value: 'new' }] }, page, ...browserStartupFields],
  { url: '', openMode: 'reuse', pageId: '$current' }, z.object({ url: z.string().url(), pageId: z.string().optional(), openMode: z.enum(['reuse', 'new']).optional(), ...browserStartup }));
add('browser.switchPage', '切换网页', '浏览器', '按网页别名切换后续指令的目标；不会重新加载页面。', true,
  [page], { pageId: 'main' }, z.object({ pageId: z.string().optional() }));
add('browser.closePage', '关闭网页', '浏览器', '可关闭一个指定网页，也可关闭本次使用的自动化浏览器中的所有网页。\n\n选择“所有网页”时，会关闭该浏览器的全部标签页和窗口，结束这个浏览器会话；不会关闭其他任务的浏览器或你另外打开的浏览器。尚未打开浏览器时，会直接继续后续步骤。', false,
  [{ key: 'closeMode', label: '关闭范围', type: 'select', required: true, options: [{ label: '指定网页', value: 'page' }, { label: '当前浏览器的所有网页', value: 'all' }] }, page],
  { closeMode: 'page', pageId: '$current' }, z.union([z.object({ closeMode: z.literal('all') }), z.object({ closeMode: z.literal('page').optional(), pageId: z.string().optional() })]));
add('browser.popupGuard', '智能屏蔽弹窗', '浏览器', '为当前浏览器持续屏蔽广告、营销、Cookie 弹层和意外新窗口；登录、支付及业务确认弹层保留。', true,
  [{ key: 'mode', label: '屏蔽模式', type: 'select', required: true, options: [{ label: '智能屏蔽（推荐）', value: 'smart' }, { label: '严格屏蔽', value: 'strict' }, { label: '关闭屏蔽', value: 'off' }] }],
  { mode: 'smart' }, z.object({ mode: z.enum(['off', 'smart', 'strict']) }));
add('browser.screenshot', '网页截图', '浏览器', '截取当前或指定网页并保存为 PNG 图片。默认截取完整网页；取消勾选后只截取当前可见区域。\n\n保存目录留空时使用当前指令或流程设置的下载目录；文件名称留空时使用 screenshot.png，可省略 .png 后缀。同名文件自动加序号，不覆盖已有图片。输出包含文件路径、名称、字节数、来源网址和网页名称，截图也会显示在运行产物中。', false,
  [page, { key: 'fullPage', label: '截取完整网页', type: 'boolean', defaultValue: true }, text('directory', '保存目录', false, '留空使用流程设置'), text('filename', '文件名称', false, 'screenshot.png')],
  { pageId: '$current', fullPage: true, directory: '', filename: '' }, browserScreenshotParamsSchema);
add('browser.wait', '等待元素', '网页操作', '流程执行到这一步时，会先等待指定的网页元素出现并显示出来，再继续执行后面的步骤。如果元素已经显示，就立即继续。\n\n例如：需要手动登录时，先等待登录后才出现的用户名显示，再执行后续操作。\n\n在“元素选择器”中填写要等待的目标。默认最多等待 30 秒，可在“设置”中的“步骤超时（毫秒）”修改；超时后按“失败后”的设置结束运行或暂停，等待人工处理。\n\n此指令只判断元素是否显示，不检查文字是否更新，也不代表整个网页已经加载完成。', true, fields, { selector: '' }, targetSchema);
add('browser.click', '点击元素', '网页操作', '在当前或指定的目标网页点击元素。\n\n标准点击会模拟真实用户点击，并检查元素是否可见、稳定且没有被遮挡。强制点击会跳过遮挡检查。DOM 点击会直接调用元素的 click()，适合 XPath 能定位但自定义控件或样式导致鼠标点击无法命中的场景。', false,
  [...fields, clickMode], { selector: '', clickMode: 'normal' }, z.object({ ...target, clickMode: clickModeSchema }).refine(p => p.selector || p.element, '请设置元素选择器'));
add('browser.fill', '输入文本', '网页操作', '填写输入框，支持 {{变量}}。', false, [...fields, text('value', '输入内容')], { selector: '', value: '' }, z.object({ ...target, value: z.string() }).refine(p => p.selector || p.element, '请设置元素选择器'));
add('browser.text', '读取文本', '数据采集', '读取元素文本，将结果写入输出变量。', true, fields, { selector: '' }, targetSchema);
add('browser.table', '读取表格', '数据采集', '提取表头和行内容。', true, fields, { selector: 'table' }, targetSchema);
add('browser.select', '选择下拉选项', '网页操作', '按值选择原生 select；自定义控件可用点击和校验组合。', false, [...fields, text('value', '选项值')], { selector: '', value: '' }, z.object({ ...target, value: z.string() }).refine(p => p.selector || p.element, '请设置元素选择器'));
add('browser.assertText', '校验页面文本', '校验', '等待页面出现期望文本，失败定位到当前步骤。', true, [...fields, text('text', '期望包含文本')], { selector: '', text: '' }, z.object({ ...target, text: z.string() }).refine(p => p.selector || p.element, '请设置元素选择器'));
add('browser.download', '点击并保存下载', '数据采集', '先监听下载再点击，保存成功后记录文件。同名文件自动加序号。', false,
  [...fields, text('directory', '保存目录', false, '留空使用流程设置'), text('filename', '文件名称', false, '订单导出.csv')], { selector: '', directory: '', filename: '' }, z.object({ ...target, directory: downloadDirectory.optional(), filename: z.string().optional() }).refine(p => p.selector || p.element, '请设置元素选择器'));
add('browser.response', '点击并采集响应', '数据采集', '在点击前监听响应，可按网址、请求方法和请求内容关联。', false,
  [...fields, text('urlIncludes', '响应网址包含'), text('method', '请求方法', false, 'GET'), text('requestIncludes', '请求内容包含', false)], { selector: '', urlIncludes: '' }, z.object({ ...target, urlIncludes: nonBlank, method: responseMethod.optional(), requestIncludes: z.string().optional() }).refine(p => p.selector || p.element, '请设置元素选择器'));
add('browser.mouseClick', '网页鼠标点击', '网页操作', '在目标网页的视口坐标点击，后台执行时不激活浏览器。可点击“获取坐标”，用 Ctrl + Alt + 左键单击选取位置。坐标以网页内容区域左上角为原点，页面滚动、缩放或布局变化后请重新确认位置。', false,
  [page, number('x', '横坐标 X'), number('y', '纵坐标 Y'), { key: 'button', label: '鼠标按钮', type: 'select', required: true, options: [{ label: '左键', value: 'left' }, { label: '中键', value: 'middle' }, { label: '右键', value: 'right' }] }, number('clickCount', '点击次数'), number('delayMs', '按下间隔（毫秒）', false, '0')],
  { pageId: '$current', x: 0, y: 0, button: 'left', clickCount: 1, delayMs: 0 },
  z.object({ pageId: z.string().optional(), x: finiteNumber.min(0), y: finiteNumber.min(0), button: z.enum(['left', 'middle', 'right']).optional(), clickCount: z.number().int().min(1).max(10).optional(), delayMs: z.number().int().min(0).max(60_000).optional() }));
add('browser.mouseMove', '网页鼠标移动', '网页操作', '把网页内的鼠标移动到指定视口坐标，后台执行时不激活浏览器。可通过“获取坐标”选取位置。', false,
  [page, number('x', '横坐标 X'), number('y', '纵坐标 Y'), number('steps', '移动步数', false, '1')],
  { pageId: '$current', x: 0, y: 0, steps: 1 },
  z.object({ pageId: z.string().optional(), x: finiteNumber.min(0), y: finiteNumber.min(0), steps: z.number().int().min(1).max(1000).optional() }));
add('browser.mouseWheel', '网页鼠标滚轮', '网页操作', '在目标网页滚动鼠标滚轮，后台执行时不激活浏览器。', false,
  [page, number('deltaX', '横向滚动'), number('deltaY', '纵向滚动')],
  { pageId: '$current', deltaX: 0, deltaY: 500 },
  z.object({ pageId: z.string().optional(), deltaX: finiteNumber, deltaY: finiteNumber }));
add('browser.keyPress', '网页按下键盘', '网页操作', '向目标网页中获得焦点的控件发送按键或快捷键，例如 Enter、ControlOrMeta+A。按下与松开之间默认保留短暂时长；后台执行时不激活浏览器。需要前台真实键盘时，可显示浏览器并使用电脑“按下键盘”指令；网站仍可能要求安全验证。', false,
  [page, text('key', '按键', true, 'ControlOrMeta+A'), number('holdMs', '按键时长（毫秒）', false, '留空自动变化')],
  { pageId: '$current', key: 'Enter' },
  z.object({ pageId: z.string().optional(), key: nonBlank, holdMs: z.number().int().min(20).max(1000).optional() }));
add('browser.keyboardType', '网页键盘输入', '网页操作', '向目标网页中获得焦点的控件输入文本。请先用点击指令选中输入位置；后台执行时不激活浏览器，也不会把文字发送给其他应用。', false,
  [page, text('text', '输入文本'), number('delayMs', '字符间隔（毫秒）', false, '0')],
  { pageId: '$current', text: '', delayMs: 0 },
  z.object({ pageId: z.string().optional(), text: z.string(), delayMs: z.number().int().min(0).max(60_000).optional() }));
add('desktop.mouseClick', '鼠标点击', '键盘和鼠标操作', '点击电脑屏幕坐标；会移动并占用真实鼠标，作用于当前前台软件或网页。坐标以整个屏幕左上角为原点。', false,
  [number('x', '屏幕横坐标 X'), number('y', '屏幕纵坐标 Y'), { key: 'button', label: '鼠标按钮', type: 'select', required: true, options: [{ label: '左键', value: 'left' }, { label: '中键', value: 'middle' }, { label: '右键', value: 'right' }] }, number('clickCount', '点击次数'), { key: 'humanLike', label: '真人轨迹（弧形移动）', type: 'boolean' }],
  { x: 0, y: 0, button: 'left', clickCount: 1, humanLike: true },
  z.object({ x: z.number().int(), y: z.number().int(), button: z.enum(['left', 'middle', 'right']), clickCount: z.number().int().min(1).max(10), ...humanMouse }));
add('desktop.mouseMove', '鼠标移动', '键盘和鼠标操作', '移动电脑真实鼠标到屏幕坐标，可用于任意前台软件或网页。', false,
  [number('x', '屏幕横坐标 X'), number('y', '屏幕纵坐标 Y'), { key: 'humanLike', label: '真人轨迹（弧形移动）', type: 'boolean' }],
  { x: 0, y: 0, humanLike: true }, z.object({ x: z.number().int(), y: z.number().int(), ...humanMouse }));
add('desktop.mouseWheel', '鼠标滚轮', '键盘和鼠标操作', '在真实鼠标当前位置滚动前台窗口；正数向上，负数向下，120 为一格。', false,
  [number('deltaX', '横向滚动'), number('deltaY', '纵向滚动')], { deltaX: 0, deltaY: -120 },
  z.object({ deltaX: z.number().int(), deltaY: z.number().int() }));
add('desktop.keyPress', '按下键盘', '键盘和鼠标操作', '向当前前台软件发送按键或快捷键，例如 Control+A、Enter。会占用真实键盘。', false,
  [text('key', '按键', true, 'Control+A')], { key: 'Enter' }, z.object({ key: nonBlank }));
add('desktop.keyboardType', '键盘输入', '键盘和鼠标操作', '向当前前台软件中获得焦点的位置输入文字；可逐字输入或通过剪贴板粘贴。粘贴会覆盖系统剪贴板当前内容。可先输入错字、删除后再输入正确文本。请先选中输入位置。', false,
  [text('text', '输入文本'), { key: 'inputMode', label: '输入方式', type: 'select', required: true, defaultValue: 'type', options: [{ label: '逐字输入', value: 'type' }, { label: '剪贴板粘贴', value: 'paste' }] }, number('delayMs', '字符间隔（毫秒）', false, '0'), { key: 'simulateTypo', label: '先输错字并删除', type: 'boolean' }, { ...text('typoText', '先输入的错字', false, '错'), defaultValue: '错' }],
  { text: '', delayMs: 0, inputMode: 'type', simulateTypo: false, typoText: '错' },
  z.object({ text: z.string(), delayMs: z.number().int().min(0).max(1000).optional(), ...typingOptions }));
add('file.xlsxRead', '读取 XLSX', '文件', '读取 .xlsx 工作表为 JSON 行列表，输出可直接交给“遍历列表”处理。', true,
  [text('path', '文件路径', true, 'C:\\RPA\\orders.xlsx'), text('sheetName', '工作表名称', false, '留空读取第一个工作表')],
  { path: '', sheetName: '' },
  z.object({ path: xlsxFilePath, sheetName: sheetName.optional() }));
add('file.xlsxWrite', '保存 XLSX', '文件', '把 JSON 对象列表或单行对象保存为 .xlsx 工作表，并登记到运行产物。', false,
  [text('path', '文件路径', true, 'C:\\RPA\\orders.xlsx'), json('rows', '行列表（JSON）'), text('sheetName', '工作表名称', false, 'Sheet1')],
  { path: '', rows: [], sheetName: 'Sheet1' },
  z.object({ path: xlsxFilePath, rows: z.union([z.array(z.record(z.string(), z.unknown())), z.record(z.string(), z.unknown()).transform(row => [row])]), sheetName: sheetName.optional() }));
add('script.run', '运行脚本', '脚本', '在独立进程运行本地脚本，通过 rpa 访问本任务的浏览器和变量。', false,
  [{ key: 'language', label: '脚本语言', type: 'select', required: true, options: [{ label: 'Python', value: 'python' }, { label: 'JavaScript', value: 'javascript' }, { label: 'TypeScript', value: 'typescript' }] }, { key: 'code', label: '脚本代码', type: 'textarea', required: true }],
  { language: 'python', code: 'from rpa_sdk import rpa\nrpa.output("脚本执行完成")' }, z.object({ language: z.enum(['python', 'javascript', 'typescript']), code: z.string().min(1) }));
add('variables.set', '设置变量', '流程控制', '设置一个 JSON 变量；完整 {{变量}} 引用保留原始类型。', true,
  [text('name', '变量名称'), json('value', '变量值（JSON）')], { name: 'result', value: '' }, z.object({ name: z.string().min(1), value: z.unknown() }));
add('core.log', '打印日志', '流程控制', '将文字或变量值写入下方运行日志。放在循环体中可逐项查看当前值，无需打开浏览器。', true,
  [{ key: 'message', label: '日志内容', type: 'textarea', required: true, placeholder: '例如：当前项：{{item}}；也可点击下方「插入变量」' }],
  { message: '' }, z.object({ message: z.json() }));
add('core.wait', '等待', '流程控制', '等待指定秒数后继续执行，默认 3 秒；支持小数和数字变量，范围为 0–3600 秒。\n\n等待期间可以停止运行；暂停请求会在当前等待完成后生效。默认按等待时长自动设置超时，也可在“设置”中指定步骤超时；所在容器的总超时仍然有效。', true,
  [{ key: 'durationSeconds', label: '等待时长（秒）', type: 'number', required: true, placeholder: '3' }],
  { durationSeconds: 3 }, z.object({ durationSeconds: z.number().min(0, '等待时长不能小于 0 秒').max(3600, '等待时长最多为 3600 秒') }));
add('core.note', '备注', '流程控制', '为流程添加说明，支持多行文字和自定义颜色。备注不会执行操作，正文中的 {{变量}} 保持原文，也不会打印到运行日志。', true,
  [{ key: 'text', label: '备注内容', type: 'textarea', required: false }, text('color', '备注颜色', false, '#FFE08A')],
  { text: '', color: '#FFE08A' }, z.object({ text: z.string(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/, '颜色必须为 #RRGGBB 格式').default('#FFE08A') }));
add('core.assert', '校验结果', '校验', '比较两个 JSON 值是否相等。', true,
  [json('actual', '实际值（JSON）'), json('expected', '期望值（JSON）')], { actual: '{{result}}', expected: '' }, z.object({ actual: z.unknown(), expected: z.unknown() }));
add('control.if', '条件分支', '流程控制', '满足条件执行子步骤，否则执行另一分支。', false,
  [json('left', '左值（JSON）'), { key: 'operator', label: '比较方式', type: 'select', options: [{ label: '等于', value: 'equals' }, { label: '不等于', value: 'notEquals' }, { label: '为真', value: 'truthy' }], required: true }, json('right', '右值（JSON）')],
  { left: true, operator: 'truthy', right: null }, z.object({ left: z.unknown(), operator: z.enum(['equals', 'notEquals', 'truthy']), right: z.unknown().optional() }));
add('control.forEach', '遍历列表', '流程控制', '逐项执行子步骤，循环结束恢复同名变量。最多 10000 项。', false,
  [json('items', '列表或变量引用（JSON）'), text('itemVariable', '当前项变量'), text('progressKey', '续跑业务键模板', false, '{{item.id}}')], { items: [], itemVariable: 'item' }, z.object({ items: z.array(z.unknown()).max(10_000), itemVariable: z.string().min(1), progressKey: z.string().optional() }));
add('control.forEachXlsx', '遍历 XLSX', '文件', '逐行遍历 XLSX；当前行是数组，可用 {{row}}[0]、{{row}}[1] 读取该行的单元格。首行不参与循环，最多 10000 行。', false,
  [text('path', '文件路径', true, 'C:\\RPA\\orders.xlsx'), text('sheetName', '工作表名称', false, '留空读取第一个工作表'), text('itemVariable', '当前项变量')],
  { path: '', sheetName: '', itemVariable: 'row', valueMode: 'array', columnIndex: 0 },
  z.object({ path: xlsxFilePath, sheetName: sheetName.optional(), itemVariable: nonBlank, progressKey: z.string().optional(),
    valueMode: z.enum(['row', 'array', 'column']).optional(), columnIndex: z.number().int().min(0).max(16_383).optional() })
    .refine(params => params.valueMode !== 'column' || params.columnIndex !== undefined, { path: ['columnIndex'], message: '单列值模式请选择列下标' }));
add('control.tryCatch', 'Try / Catch', '流程控制', '先执行 Try 内的指令；成功时跳过 Catch，失败时跳过 Try 剩余指令并执行 Catch，处理完成后继续后续步骤。\n\nCatch 内可通过 {{error.message}}、{{error.stepId}}、{{error.stepName}} 和 {{error.actionType}} 读取异常。异常变量名可修改，仅在 Catch 内有效，结束后恢复原来的同名变量。\n\nTry 内的指令完成配置的重试后才进入 Catch，不会先按“失败后暂停”等待。Catch 自身失败会继续向外抛出；用户停止、本容器或祖先容器的总超时不能在本 Catch 中处理。', false,
  [text('errorVariable', '异常变量', true, 'error')], { errorVariable: 'error' }, z.object({
    errorVariable: z.string().min(1, '请填写异常变量名').refine(value => value.trim() === value && !/[{}]/.test(value), '变量名不能包含首尾空格或花括号')
      .refine(value => !['__proto__', 'prototype', 'constructor'].includes(value), '该变量名为保留名称'),
  }));

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
      for (const check of step.recoveryChecks ?? []) { if (!getAction(check.actionType).metadata.safeToRetry || check.children?.length || check.elseSteps?.length) throw new Error('恢复检查只能包含只读或内部校验指令'); }
      if (!['control.if', 'control.forEach', 'control.forEachXlsx', 'control.tryCatch'].includes(step.actionType) && ((step.children?.length ?? 0) || (step.elseSteps?.length ?? 0))) throw new Error(`“${step.name}”不是容器动作，不能包含子步骤。`);
      if (['control.forEach', 'control.forEachXlsx'].includes(step.actionType) && step.elseSteps?.length) throw new Error('循环不支持否则分支');
      visit(step.children ?? []); visit(step.elseSteps ?? []);
    }
  }; visit(workflow.steps);
}
