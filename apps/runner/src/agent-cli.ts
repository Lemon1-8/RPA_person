#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentCommand } from './agent.js';

async function main() {
  const root = typeof __dirname !== 'undefined' ? resolve(__dirname,'../..') : resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT',abort); process.once('SIGTERM',abort);
  const result = await agentCommand(process.argv.slice(2),{runtimeRoot:root,callerDirectory:process.cwd(),signal:controller.signal,onLog:message => process.stderr.write(message.endsWith('\n') ? message : `${message}\n`)});
  process.off('SIGINT',abort); process.off('SIGTERM',abort);
  process.stdout.write(`${JSON.stringify(result.response)}\n`);
  process.exitCode = result.exitCode;
}
void main().catch(error => {
  process.stdout.write(`${JSON.stringify({apiVersion:1,ok:false,error:{code:'INTERNAL_ERROR',message:String(error)}})}\n`);
  process.exitCode = 2;
});
