import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '../packages/contracts/src/index.js';
import { BrowserOpenFields } from '../apps/desktop/src/renderer/BrowserFields.js';

function renderFields(debugPort?: unknown) {
  const workflow: WorkflowDefinition = {
    schemaVersion: 1, workflowId: 'browser-port', name: '端口配置', revision: 1, variables: {}, elements: {},
    settings: { downloadDir: 'C:\\RPA', headless: true },
    steps: [{ stepId: 'open', name: '打开网页', actionType: 'browser.open', params: { url: 'https://example.test', ...(debugPort !== undefined ? { debugPort } : {}) } }],
  };
  return renderToStaticMarkup(createElement(BrowserOpenFields, {
    workflow, step: workflow.steps[0], pages: [], onChange: () => {}, onValidity: () => {},
  }));
}

describe('打开网页的浏览器端口设置', () => {
  it('默认明确选择自动分配，折叠标题也显示端口模式', () => {
    const html = renderFields();
    expect(html).toContain('aria-label="浏览器端口分配"');
    expect(html).toMatch(/<option value="auto" selected="">自动分配<\/option>/);
    expect(html).toContain('端口：自动分配');
    expect(html).not.toContain('aria-label="浏览器端口"');
  });

  it('已保存的手动端口显示手动指定及端口输入，不会丢失原值', () => {
    const html = renderFields(9333);
    expect(html).toMatch(/<option value="manual" selected="">手动指定<\/option>/);
    expect(html).toContain('aria-label="浏览器端口"');
    expect(html).toContain('value="9333"');
    expect(html).toContain('端口：9333');
  });

  it('已有debugPort=0仍按自动分配展示', () => {
    expect(renderFields(0)).toMatch(/<option value="auto" selected="">自动分配<\/option>/);
  });
});
