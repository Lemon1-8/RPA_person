import type { WorkflowDefinition } from '../packages/contracts/src/index.js';
export function createDemoWorkflow(url: string, downloadDir: string, headless = false): WorkflowDefinition {
  return {
    schemaVersion: 1, workflowId: 'order-export-demo', name: '订单采集与导出', revision: 0,
    variables: { demoUrl: url, customer: '跨语言订单' }, elements: {}, settings: { downloadDir, headless },
    steps: [
      { stepId: 'open', name: '打开订单演示页', actionType: 'browser.open', params: { url: '{{demoUrl}}' } },
      { stepId: 'fill', name: '填写客户筛选', actionType: 'browser.fill', params: { selector: '#customer', value: '{{customer}}' } },
      { stepId: 'python', name: 'Python 读取当前页面', actionType: 'script.run', params: { language: 'python', code: 'from rpa_sdk import rpa\ncustomer = rpa.call("browser.evaluate", {"expression": "document.querySelector(\'#customer\').value"})\nrpa.set("pythonCustomer", customer)\nprint("Python 已读取客户：", customer)\nrpa.output(customer)' }, output: 'pythonResult' },
      { stepId: 'javascript', name: 'JavaScript 共享变量', actionType: 'script.run', params: { language: 'javascript', code: 'const value = await rpa.get("pythonCustomer");\nawait rpa.set("jsCustomer", value);\nconsole.log("JavaScript 已接收：", value);\nawait rpa.output(value);' }, output: 'jsResult' },
      { stepId: 'typescript', name: 'TypeScript 操作同一页面', actionType: 'script.run', params: { language: 'typescript', code: 'const value: string = String(await rpa.get("jsCustomer"));\nawait rpa.call("browser.fill", { selector: "#customer", value });\nawait rpa.output(value);' }, output: 'tsResult' },
      { stepId: 'query', name: '查询订单', actionType: 'browser.click', params: { selector: '#query' } },
      { stepId: 'verify', name: '确认查询结果', actionType: 'browser.assertText', params: { selector: '#status', text: '查询完成：{{customer}}' }, timeoutMs: 15_000 },
      { stepId: 'read', name: '采集订单表格', actionType: 'browser.table', params: { selector: '#orders' }, output: 'orders' },
      { stepId: 'download', name: '导出并保存 CSV', actionType: 'browser.download', params: { selector: '#download', filename: '订单导出.csv' }, output: 'download', timeoutMs: 30_000 },
    ],
  };
}
