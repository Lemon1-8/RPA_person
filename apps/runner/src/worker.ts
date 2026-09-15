import { WorkflowEngine, type EngineOptions } from '../../../packages/engine/src/index.js';
import type { RunCommand, WorkflowDefinition } from '../../../packages/contracts/src/index.js';
let engine: WorkflowEngine | undefined;
let started = false;
let finished = false;
let controls = 0;
function releaseWorkerWhenClosed() {
  setImmediate(() => {
    if (finished && controls === 0 && !engine?.getSnapshot().browserOpen && process.connected) process.disconnect?.();
  });
}
process.on('message', (message: { type: string; requestId?: string; command?: RunCommand; workflow?: WorkflowDefinition; options?: EngineOptions }) => {
  if (message.type === 'control' && message.command) {
    controls++;
    void (async () => {
      let error: string | undefined;
      try { if (!engine) throw new Error('任务执行器尚未启动'); await engine.control(message.command!); }
      catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
      if (process.connected) await new Promise<void>(resolve => {
        process.send?.({ type: 'control-result', requestId: message.requestId, error }, () => resolve());
      });
      controls--; releaseWorkerWhenClosed();
    })();
  }
  if (message.type === 'start' && !started) {
    started = true;
    try {
      engine = new WorkflowEngine(message.workflow!, { ...message.options!, onEvent: event => {
        if (process.connected) process.send?.({ type: 'event', event });
        if (event.run && !event.run.browserOpen) releaseWorkerWhenClosed();
      } });
      engine.run().then(() => { finished = true; releaseWorkerWhenClosed(); }).catch(error => { console.error(error); process.exitCode = 1; process.disconnect?.(); });
    } catch (error) { console.error(error); process.exitCode = 1; process.disconnect?.(); }
  }
});
process.on('disconnect', () => { engine?.control('stop').catch(() => {}); });
process.on('SIGTERM', () => { engine?.control('stop').finally(() => { process.exitCode = 0; }); });
