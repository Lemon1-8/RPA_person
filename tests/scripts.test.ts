import { describe, expect, it } from 'vitest';
import { runScript } from '../packages/scripts/src/index.js';

describe('script bridge', () => {
  it('JavaScript calls the owning engine and shares current JSON variables', async () => {
    const variables: Record<string, unknown> = { name: '订单' };
    const result = await runScript({
      language: 'javascript',
      code: `
        const name = await rpa.get('name');
        const value = await rpa.call('browser.text', { selector: '#value' });
        await rpa.set('summary', { name, value });
        await rpa.output(await rpa.get('summary'));
      `,
      variables,
      timeoutMs: 10_000,
      dispatch: async (method, params) => {
        if (method === 'variables.get') return variables[String(params.name)];
        if (method === 'variables.set') {
          variables[String(params.name)] = params.value;
          return null;
        }
        if (method === 'browser.text' && params.selector === '#value') return '三笔';
        throw new Error(`Unexpected method: ${method}`);
      },
    });
    expect(result).toEqual({ name: '订单', value: '三笔' });
    expect(variables.summary).toEqual(result);
  });

  it('TypeScript supports type annotations, top-level await and ordinary logs', async () => {
    const logs: string[] = [];
    const result = await runScript({
      language: 'typescript',
      code: `
        const count: number = 3;
        console.log('已采集', count, '行');
        await rpa.output({ count });
      `,
      variables: {}, timeoutMs: 10_000,
      dispatch: async () => null,
      onLog: (message) => logs.push(message),
    });
    expect(result).toEqual({ count: 3 });
    expect(logs).toContain('已采集 3 行');
  });

  it('Python uses synchronous RPC with the same variables and preserves print logs', async () => {
    const variables: Record<string, unknown> = { name: '订单' };
    const logs: string[] = [];
    const result = await runScript({
      language: 'python',
      code: `from rpa_sdk import rpa
print('Python 正在处理')
text = rpa.call('browser.text', {'selector': '#value'})
rpa.set('count', text)
rpa.output({'name': rpa.get('name'), 'count': rpa.get('count')})
`,
      variables, timeoutMs: 10_000,
      dispatch: async (method, params) => {
        if (method === 'variables.get') return variables[String(params.name)];
        if (method === 'variables.set') { variables[String(params.name)] = params.value; return null; }
        if (method === 'browser.text') return '三笔';
        throw new Error(`Unexpected method: ${method}`);
      },
      onLog: (message) => logs.push(message),
    });
    expect(result).toEqual({ name: '订单', count: '三笔' });
    expect(logs).toContain('Python 正在处理');
  });

  it('a CPU-bound script is terminated when its step timeout expires', async () => {
    await expect(runScript({
      language: 'javascript',
      code: `const until = Date.now() + 1500; while (Date.now() < until) {} await rpa.output('late');`,
      variables: {}, timeoutMs: 500,
      dispatch: async () => null,
    })).rejects.toThrow(/timeout/i);
  });

  it('cancellation stops a script and its spawned descendant before returning', async () => {
    const controller = new AbortController();
    let descendantPid = 0;
    await expect(runScript({
      language: 'javascript',
      code: `
        import { spawn } from 'node:child_process';
        const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
        console.log('descendant:' + descendant.pid);
        await new Promise(resolve => setTimeout(resolve, 1500));
        descendant.kill();
        await rpa.output('late');
      `,
      variables: {}, timeoutMs: 10_000, signal: controller.signal,
      dispatch: async () => null,
      onLog: (line) => {
        if (!line.startsWith('descendant:')) return;
        descendantPid = Number(line.slice('descendant:'.length));
        controller.abort();
      },
    })).rejects.toThrow(/cancel/i);
    expect(descendantPid).toBeGreaterThan(0);
    expect(() => process.kill(descendantPid, 0)).toThrow();
  });

  it('large JSON script outputs arrive intact before the child exits', async () => {
    const result = await runScript({
      language: 'javascript', code: `await rpa.output('数据'.repeat(150_000));`,
      variables: {}, timeoutMs: 10_000, dispatch: async () => null,
    });
    expect(typeof result).toBe('string');
    expect((result as string).length).toBe(300_000);
    expect((result as string).slice(-4)).toBe('数据数据');
  });

  it('plain stdout containing JSON-looking log lines cannot corrupt RPC', async () => {
    const logs: string[] = [];
    const result = await runScript({
      language: 'javascript',
      code: `process.stdout.write('null\\n42\\n{"note":"日志"}\\n'); await rpa.output('ok');`,
      variables: {}, timeoutMs: 10_000, dispatch: async () => null,
      onLog: (message) => logs.push(message),
    });
    expect(result).toBe('ok');
    expect(logs).toEqual(['null', '42', '{"note":"日志"}']);
  });

  it.each([
    { language: 'javascript' as const, code: `await rpa.call('browser.text', { selector: '#missing' });` },
    { language: 'python' as const, code: `from rpa_sdk import rpa\nrpa.call('browser.text', {'selector': '#missing'})` },
  ])('$language reports engine RPC failures as a failed script step', async ({ language, code }) => {
    await expect(runScript({
      language, code, variables: {}, timeoutMs: 10_000,
      dispatch: async () => { throw new Error('目标元素不存在'); },
    })).rejects.toThrow('目标元素不存在');
  });

  it('a cancelled signal prevents the script from starting or invoking the engine', async () => {
    const controller = new AbortController();
    controller.abort();
    let invoked = false;
    await expect(runScript({
      language: 'javascript', code: `await rpa.call('browser.click', { selector: '#export' });`,
      variables: {}, timeoutMs: 10_000, signal: controller.signal,
      dispatch: async () => { invoked = true; return null; },
    })).rejects.toThrow(/cancel/i);
    expect(invoked).toBe(false);
  });

  it('normal completion drains unawaited RPC and chained calls before returning', async () => {
    const variables: Record<string, unknown> = {};
    const result = await runScript({
      language: 'javascript',
      code: `
        void rpa.set('first', 1).then(() => rpa.set('second', 2));
        await rpa.output('done');
      `,
      variables: {}, timeoutMs: 10_000,
      dispatch: async (_method, params) => {
        await new Promise(resolve => setTimeout(resolve, 60));
        variables[String(params.name)] = params.value;
        return null;
      },
    });
    expect(result).toBe('done');
    expect(variables).toEqual({ first: 1, second: 2 });
  });

  it('an unawaited RPC rejection fails the script after draining the request', async () => {
    await expect(runScript({
      language: 'javascript', code: `void rpa.call('browser.click', { selector: '#missing' }); await rpa.output('done');`,
      variables: {}, timeoutMs: 10_000,
      dispatch: async () => {
        await new Promise(resolve => setTimeout(resolve, 40));
        throw new Error('尚未处理的点击失败');
      },
    })).rejects.toThrow('尚未处理的点击失败');
  });

  it('an awaited RPC rejection caught by user code permits normal recovery', async () => {
    const result = await runScript({
      language: 'javascript',
      code: `
        try { await rpa.call('browser.text', { selector: '#optional' }); }
        catch { await rpa.output({ fallback: true }); }
      `,
      variables: {}, timeoutMs: 10_000,
      dispatch: async () => { throw new Error('可选元素不存在'); },
    });
    expect(result).toEqual({ fallback: true });
  });

  it('a process-level rejection logger does not convert failed unawaited RPC into success', async () => {
    await expect(runScript({
      language: 'javascript',
      code: `process.on('unhandledRejection', error => console.error('logged', error.message)); void rpa.call('browser.click', {}); await rpa.output('done');`,
      variables: {}, timeoutMs: 10_000,
      dispatch: async () => { throw new Error('必须向步骤回传的失败'); },
    })).rejects.toThrow('必须向步骤回传的失败');
  });

  it('cancellation does not wait forever for an uncooperative engine RPC', async () => {
    const controller = new AbortController();
    await expect(runScript({
      language: 'javascript', code: `await rpa.call('browser.wait', { selector: '#never' });`,
      variables: {}, timeoutMs: 10_000, signal: controller.signal,
      dispatch: async () => {
        controller.abort();
        return new Promise(() => {});
      },
    })).rejects.toThrow(/cancel/i);
  });
});
