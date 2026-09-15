import { z } from 'zod';
import { isAbsolute } from 'node:path';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface ElementRef { pageRef?: string; framePath?: string[]; selector: string; expectedCount?: number }
export interface StepDefinition {
  stepId: string; name: string; actionType: string; params: Record<string, unknown>; output?: string;
  timeoutMs?: number; retry?: { maxAttempts: number; delayMs: number }; onError?: 'fail' | 'pause';
  children?: StepDefinition[]; elseSteps?: StepDefinition[];
}
export interface WorkflowDefinition {
  schemaVersion: 1; workflowId: string; name: string; revision: number;
  variables: Record<string, JsonValue>; elements: Record<string, ElementRef>; steps: StepDefinition[];
  settings: { downloadDir: string; headless: boolean; keepBrowserOpen?: boolean; profileId?: string; pythonExecutable?: string };
}
export interface ActionField {
  key: string; label: string; type: 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'json';
  required?: boolean; options?: { label: string; value: string }[]; defaultValue?: unknown; placeholder?: string;
}
export interface ActionDefinition {
  type: string; label: string; category: string; description: string; safeToRetry: boolean;
  fields: ActionField[]; defaults: Record<string, unknown>;
}
export interface Artifact { path: string; name: string; size: number; sourceUrl?: string; stepId?: string }
export type RunStatus = 'queued' | 'running' | 'paused' | 'waiting_manual' | 'succeeded' | 'failed' | 'stopped' | 'interrupted';
export interface RunSnapshot {
  runId: string; workflowId: string; workflowName: string; revision: number; status: RunStatus;
  startedAt: string; endedAt?: string; currentStepId?: string; variables: Record<string, unknown>;
  artifacts: Artifact[]; error?: string; browserOpen?: boolean;
}
export interface RunEvent {
  type: 'run' | 'step' | 'log' | 'artifact'; runId: string; at: string; stepId?: string;
  status?: string; message?: string; data?: unknown; run?: RunSnapshot;
}
export type RunCommand = 'pause' | 'resume' | 'stop' | 'show' | 'hide' | 'closeBrowser';
export interface BootstrapData {
  workflows: WorkflowDefinition[]; actions: ActionDefinition[]; runs: RunSnapshot[];
  demoUrl: string; dataDir: string; defaultDownloadDir: string;
}
export interface DesktopApi {
  bootstrap(): Promise<BootstrapData>;
  saveWorkflow(workflow: WorkflowDefinition): Promise<WorkflowDefinition>;
  runWorkflow(workflow: WorkflowDefinition): Promise<RunSnapshot>;
  controlRun(runId: string, command: RunCommand): Promise<void>;
  chooseDirectory(): Promise<string | null>;
  openPath(path: string): Promise<void>;
  onEvent(listener: (event: RunEvent) => void): () => void;
}

const safeKey = z.string().min(1).refine(k => !['__proto__', 'constructor', 'prototype'].includes(k), '变量名不可为保留属性');
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/, '标识只能使用字母、数字、短横线及下划线');
const jsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(), z.array(jsonValue), z.record(safeKey, jsonValue),
]));
const elementSchema = z.object({ pageRef: z.string().optional(), framePath: z.array(z.string().min(1)).optional(), selector: z.string().min(1), expectedCount: z.number().int().positive().optional() });
const stepSchema: z.ZodType<StepDefinition> = z.lazy(() => z.object({
  stepId: identifier, name: z.string().min(1), actionType: z.string().min(1), params: z.record(safeKey, jsonValue),
  output: safeKey.optional(), timeoutMs: z.number().int().min(100).max(3_600_000).optional(),
  retry: z.object({ maxAttempts: z.number().int().min(1).max(5), delayMs: z.number().int().min(0).max(60_000) }).optional(),
  onError: z.enum(['fail', 'pause']).optional(), children: z.array(stepSchema).optional(), elseSteps: z.array(stepSchema).optional(),
}));
export const workflowSchema: z.ZodType<WorkflowDefinition> = z.object({
  schemaVersion: z.literal(1), workflowId: identifier, name: z.string().min(1).max(120), revision: z.number().int().nonnegative(),
  variables: z.record(safeKey, jsonValue), elements: z.record(safeKey, elementSchema), steps: z.array(stepSchema).max(1000),
  settings: z.object({ downloadDir: z.string().min(1).refine(value => isAbsolute(value) && (process.platform !== 'win32' || /^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value)), '下载目录必须是完整绝对路径'), headless: z.boolean(), keepBrowserOpen: z.boolean().optional(), profileId: identifier.optional(), pythonExecutable: z.string().min(1).optional() }),
}).superRefine((flow, ctx) => {
  const ids = new Set<string>(); let count = 0;
  const visit = (steps: StepDefinition[], depth: number) => {
    if (depth > 20) { ctx.addIssue({ code: 'custom', message: '流程嵌套超过 20 层' }); return; }
    for (const s of steps) {
      if (ids.has(s.stepId)) ctx.addIssue({ code: 'custom', message: `重复步骤标识：${s.stepId}` });
      ids.add(s.stepId); count++;
      visit(s.children ?? [], depth + 1); visit(s.elseSteps ?? [], depth + 1);
    }
  }; visit(flow.steps, 0);
  if (count > 1000) ctx.addIssue({ code: 'custom', message: '流程最多 1000 个步骤' });
});
