import type { ElementRef, RunEvent, RunSnapshot, WorkflowDefinition } from './index.js';

export interface WorkflowDraft {
  workflowId: string; baseRevision: number; updatedAt: string;
  workflow: WorkflowDefinition; selectedId: string; fieldTexts: Record<string, string>;
}
export interface WorkflowRevision { revision: number; name: string }
export interface EventQuery { before?: number; limit?: number; query?: string; attemptId?: string }
export interface EventPage { events: RunEvent[]; before?: number; hasMore: boolean; damagedLines: number }
export interface RunWarning { stepId: string; stepName: string; message: string; at: string }
export interface StorageIssue { id: string; message: string; at: string }
export interface RunAttempt { attemptId: string; run: RunSnapshot; workflow: WorkflowDefinition }
export interface BrowserElementCapture { element: ElementRef; text: string; stable: boolean; title: string }
export interface BrowserElementValidation { count: number; texts: string[] }
export interface PreflightIssue { stepId?: string; level: 'error' | 'warning'; message: string }
export interface ScheduleOccurrence {
  scheduleId: string; scheduledFor: string; runId: string;
  outcome: 'claimed' | 'started' | 'skipped'; reason?: string;
  workflowId?: string; revision?: number;
}
export interface RunHistoryQuery { offset?:number;limit?:number;workflowId?:string;status?:RunSnapshot['status'];from?:string;to?:string;archived?:boolean }
export interface CleanupPreview { token:string;runIds:string[];revisions:{workflowId:string;revision:number}[];files:string[];bytes:number;protected:string[] }
export interface WorkbenchApi {
  listDrafts(): Promise<WorkflowDraft[]>;
  saveDraft(draft: WorkflowDraft): Promise<void>;
  discardDraft(workflowId: string): Promise<void>;
  listRevisions(workflowId: string): Promise<WorkflowRevision[]>;
  getRevision(workflowId: string, revision: number): Promise<WorkflowDefinition>;
  restoreRevision(workflowId: string, revision: number, expectedRevision: number): Promise<WorkflowDefinition>;
  getRunEvents(runId: string, query?: EventQuery): Promise<EventPage>;
  exportRunEvents(runId: string): Promise<string | null>;
  listAttempts(runId: string): Promise<RunAttempt[]>;
  getStorageIssues(): Promise<StorageIssue[]>;
  retryStorage(): Promise<StorageIssue[]>;
  onStorageIssues(listener: (issues: StorageIssue[]) => void): () => void;
  onFlushDrafts(listener: () => Promise<void>): () => void;
  onFocusRun(listener: (runId: string) => void): () => void;
  preflight(workflow: WorkflowDefinition): Promise<PreflightIssue[]>;
  pickBrowserElement(runId: string, pageId: string, requestId: string): Promise<BrowserElementCapture | null>;
  cancelBrowserElement(runId: string, requestId: string): Promise<void>;
  validateBrowserElement(runId: string, element: ElementRef): Promise<BrowserElementValidation>;
  debugRun(workflow: WorkflowDefinition, breakpoints: string[], fromStepId?: string): Promise<RunSnapshot>;
  recoverRun(runId: string): Promise<RunSnapshot>;
  listOccurrences(scheduleId: string): Promise<ScheduleOccurrence[]>;
  archiveRun(runId: string, archived: boolean): Promise<void>;
  getRunVariables(runId: string): Promise<Record<string, unknown>>;
  getStepResult(runId: string, resultId: string): Promise<unknown>;
  queryRuns(query:RunHistoryQuery):Promise<{runs:RunSnapshot[];total:number}>;
  previewCleanup(runIds:string[],revisions:{workflowId:string;revision:number}[]):Promise<CleanupPreview>;
  applyCleanup(token:string):Promise<void>;
}
