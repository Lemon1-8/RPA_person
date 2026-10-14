import { useContext, useEffect, useMemo, useReducer, useRef, useState, lazy, Suspense, type ReactNode } from "react";
import {
  AlertCircle,
  Braces,
  CalendarClock,
  Check,
  ChevronRight,
  Circle,
  Clock3,
  Code2,
  Download,
  Eye,
  EyeOff,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  GitBranch,
  Globe,
  Keyboard,
  Layers,
  ListTree,
  Loader2,
  MousePointerClick,
  MousePointer2,
  Pause,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  Redo2,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  StickyNote,
  Terminal,
  Undo2,
  Workflow,
  X,
} from "lucide-react";
import type {
  ActionDefinition,
  Artifact,
  BrowserPageInfo,
  DesktopApi,
  RunCommand,
  RunEvent,
  RunSnapshot,
  StepDefinition,
  WorkflowDefinition,
  WorkflowSchedule,
} from "../../../../packages/contracts/src/index.js";
import { WorkflowsPage } from "./WorkflowsPage.js";
const SchedulesPage=lazy(()=>import("./SchedulesPage.js").then(module=>({default:module.SchedulesPage})));
import { mergeRunEvent } from "../../../../packages/contracts/src/run-events.js";
import { AttemptRecords } from './AttemptRecords.js';
import { cacheRunEvents } from './event-cache.js';
import { WarningRecords } from './WarningRecords.js';
const RunHistory=lazy(()=>import("./RunHistory.js").then(module=>({default:module.RunHistory})));
import { StepTree } from "./StepTree.js";
import { ControlFlowFields, getControlStepErrors } from "./ControlFlowFields.js";
import { NoteFields, getNoteStepErrors } from "./NoteFields.js";
import { VariablePicker } from "./VariablePicker.js";
import { BrowserCloseFields, BrowserOpenFields, PageTargetField } from "./BrowserFields.js";
import { CoordinatePicker } from "./CoordinatePicker.js";
import { DesktopCoordinatePicker } from "./DesktopCoordinatePicker.js";
import { DesktopElements } from "./DesktopElements.js";
import { DesktopTargetField } from "./DesktopTargetField.js";
import { KeyPressField } from "./KeyPressField.js";
import { XlsxPathField } from "./XlsxPathField.js";
import { LogViewer } from "./LogViewer.js";
import { getBrowserPageErrors, getInheritedPageTarget } from "./page-options.js";
import { editorReducer, emptyEditorState } from "./editor-history.js";
import { explainError, runRecovery } from "./run-feedback.js";
import { DraftContext } from './DraftContext.js';
import { RevisionHistory } from './RevisionHistory.js';
const WebElements=lazy(()=>import('./WebElements.js').then(module=>({default:module.WebElements})));
import { ValueViewer } from './ValueViewer.js';
const ScriptEditor=lazy(()=>import('./ScriptEditor.js').then(module=>({default:module.ScriptEditor})));
import { editSelectedSteps } from './step-editing.js';
import type { PreflightIssue } from '../../../../packages/contracts/src/index.js';
import type { WorkflowDraft, StorageIssue } from '../../../../packages/contracts/src/index.js';

const api = (window as Window & { rpa?: DesktopApi }).rpa;
const terminalStatuses = new Set([
  "succeeded",
  "failed",
  "stopped",
  "interrupted",
]);
const advancedActions = new Set(['browser.text', 'browser.table', 'browser.response', 'browser.select', 'browser.assertText', 'core.assert']);
const statusLabels: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  paused: "已暂停",
  waiting_manual: "等待人工",
  succeeded: "已完成",
  failed: "失败",
  stopped: "已停止",
  interrupted: "意外中断",
  started: "开始",
  retrying: "重试中",
  skipped: "已跳过",
};
type RunTab = "logs" | "variables" | "artifacts" | "runs";
type InspectorTab = "step" | "settings" | "inputs" | "elements";
type StepLocation = {
  step: StepDefinition;
  siblings: StepDefinition[];
  index: number;
  parentId?: string;
  branch?: "children" | "elseSteps";
  depth: number;
};
const uuid = () => crypto.randomUUID();
const clone = <T,>(value: T): T => structuredClone(value);
const formatTime = (value: string) =>
  new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
const toText = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value);
function flatten(
  steps: StepDefinition[],
  depth = 0,
  parentId?: string,
  branch?: "children" | "elseSteps",
): StepLocation[] {
  return steps.flatMap((step, index) => [
    { step, siblings: steps, index, parentId, branch, depth },
    ...flatten(step.children ?? [], depth + 1, step.stepId, "children"),
    ...flatten(step.elseSteps ?? [], depth + 1, step.stepId, "elseSteps"),
  ]);
}

function replaceStep(
  steps: StepDefinition[],
  id: string,
  update: (step: StepDefinition) => StepDefinition,
): StepDefinition[] {
  return steps.map((step) =>
    step.stepId === id
      ? update(step)
      : {
          ...step,
          ...(step.children
            ? { children: replaceStep(step.children, id, update) }
            : {}),
          ...(step.elseSteps
            ? { elseSteps: replaceStep(step.elseSteps, id, update) }
            : {}),
        },
  );
}

function changeSiblings(
  steps: StepDefinition[],
  id: string,
  update: (siblings: StepDefinition[], index: number) => StepDefinition[],
): StepDefinition[] {
  const index = steps.findIndex((step) => step.stepId === id);
  if (index >= 0) return update(steps, index);
  return steps.map((step) => ({
    ...step,
    ...(step.children
      ? { children: changeSiblings(step.children, id, update) }
      : {}),
    ...(step.elseSteps
      ? { elseSteps: changeSiblings(step.elseSteps, id, update) }
      : {}),
  }));
}

function copyStep(step: StepDefinition): StepDefinition {
  return {
    ...clone(step),
    stepId: uuid(),
    ...(step.children ? { children: step.children.map(copyStep) } : {}),
    ...(step.elseSteps ? { elseSteps: step.elseSteps.map(copyStep) } : {}),
    ...(step.recoveryChecks ? { recoveryChecks: step.recoveryChecks.map(copyStep) } : {}),
  };
}

function ActionIcon({ type, size = 17 }: { type: string; size?: number }) {
  if (type === "core.log") return <Terminal size={size} />;
  if (type === "core.wait") return <Clock3 size={size} />;
  if (type === "core.note") return <StickyNote size={size} />;
  if (type === "control.tryCatch") return <ShieldCheck size={size} />;
  if (type === "browser.popupGuard") return <ShieldCheck size={size} />;
  if (type.startsWith("file.xlsx") || type === "control.forEachXlsx") return <FileSpreadsheet size={size} />;
  if (type.startsWith("browser.key") || type === "browser.keyboardType" || type.startsWith("desktop.key")) return <Keyboard size={size} />;
  if (type.startsWith("browser.mouse") || type.startsWith("desktop.mouse")) return <MousePointerClick size={size} />;
  if (/script|python|javascript|typescript/.test(type))
    return <Code2 size={size} />;
  if (/download/.test(type)) return <Download size={size} />;
  if (/click|fill|select/.test(type)) return <MousePointer2 size={size} />;
  if (/if|condition|loop|each/i.test(type)) return <GitBranch size={size} />;
  if (/variable|assert/.test(type)) return <Braces size={size} />;
  if (/browser|page|navigate|open/.test(type)) return <Globe size={size} />;
  return <Layers size={size} />;
}

function Status({ status }: { status: string }) {
  return (
    <span className={`status status-${status}`}>
      <span className="status-dot" />
      {statusLabels[status] ?? status}
    </span>
  );
}

function RetainedBrowserStatus() {
  return (
    <span
      className="status status-browser-retained"
      title="流程已结束，浏览器仍占用资源。可显示、最小化或手动关闭。"
    >
      <Globe size={11} />
      浏览器保留中
    </span>
  );
}
function ActionLibraryGroup({ category, children }: { category: string; children: ReactNode }) {
  return category === '高级采集与校验' ? <details className="action-group advanced-actions"><summary>{category}</summary>{children}</details> : <section className="action-group"><h3>{category}</h3>{children}</section>;
}

function IconButton({
  label,
  title,
  children,
  disabled,
  onClick,
  danger,
}: {
  label: string;
  title?: string;
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-button${danger ? " danger" : ""}`}
      title={title ?? label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function JsonEditor({
  label,
  value,
  onChange,
  onValidity,
  hint,
  objectOnly = false,
  disabled = false,
}: {
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
  onValidity: (valid: boolean) => void;
  hint?: string;
  objectOnly?: boolean;
  disabled?: boolean;
}) {
  const serialized = JSON.stringify(value === undefined ? {} : value, null, 2);
  const drafts = useContext(DraftContext);
  const draftKey = `${drafts.scope}:${label}`;
  const [draft, setDraft] = useState(drafts.texts[draftKey] ?? serialized);
  const [error, setError] = useState("");
  const ownValue = useRef(serialized);
  useEffect(() => {
    if (drafts.texts[draftKey] !== undefined) {
      const text = drafts.texts[draftKey]; setDraft(text);
      try { const parsed = JSON.parse(text); if (objectOnly && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error(); setError(''); onValidity(true); }
      catch { setError('JSON 格式无效，请检查引号、逗号及括号。'); onValidity(false); }
      return;
    }
    if (ownValue.current !== serialized) {
      setDraft(serialized);
      ownValue.current = serialized;
    }
    setError("");
    onValidity(true);
  }, [serialized, draftKey, drafts.texts[draftKey]]);
  return (
    <label className="field">
      <span>{label}</span>
      <textarea
        aria-label={label}
        spellCheck={false}
        disabled={disabled}
        className={`code-input${error ? " input-error" : ""}`}
        value={draft}
        aria-invalid={!!error}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          drafts.write(draftKey, text);
          try {
            const parsed: unknown = JSON.parse(text);
            if (
              objectOnly &&
              (parsed === null ||
                Array.isArray(parsed) ||
                typeof parsed !== "object")
            )
              throw new Error("请输入 JSON 对象，例如 {}。");
            ownValue.current = JSON.stringify(parsed, null, 2);
            setError("");
            onValidity(true);
            drafts.write(draftKey, undefined);
            onChange(parsed);
          } catch (cause) {
            setError(
              cause instanceof Error && cause.message.startsWith("请输入")
                ? cause.message
                : "JSON 格式无效，请检查引号、逗号及括号。",
            );
            onValidity(false);
          }
        }}
      />
      {error ? (
        <span className="field-error">{error}</span>
      ) : (
        hint && <small>{hint}</small>
      )}
    </label>
  );
}

export function App() {
  const [view, setView] = useState<"editor" | "workflows" | "schedules" | "settings">("editor");
  const [schedules, setSchedules] = useState<WorkflowSchedule[]>([]);
  const [openFlows, setOpenFlows] = useState<string[]>([]);
  const [panels, setPanels] = useState(() => {
    try {
      const savedPanels = JSON.parse(localStorage.getItem("rpa.panels") ?? "{}");
      return { left: savedPanels.left !== false, right: savedPanels.right !== false };
    } catch { return { left: true, right: true }; }
  });
  const [editorState, dispatchEditor] = useReducer(editorReducer, emptyEditorState);
  const [pendingDrafts, setPendingDrafts] = useState<WorkflowDraft[]>([]);
  const [draftTexts, setDraftTexts] = useState<Record<string, Record<string, string>>>({});
  const [storageIssues, setStorageIssues] = useState<StorageIssue[]>([]);
  const [preflightIssues, setPreflightIssues] = useState<PreflightIssue[]>([]);
  const [breakpoints, setBreakpoints] = useState<Record<string, string[]>>({});
  const [attempts, setAttempts] = useState<import('../../../../packages/contracts/src/index.js').RunAttempt[]>([]);
  const draftQueue = useRef<Promise<unknown>>(Promise.resolve());
  const managedDrafts = useRef(new Set<string>());
  const flushDrafts = useRef<() => Promise<void>>(async () => {});
  const firstDraftEditAt = useRef<number | undefined>(undefined);
  const workflows = editorState.workflows;
  const setWorkflows = (update: WorkflowDefinition[] | ((previous: WorkflowDefinition[]) => WorkflowDefinition[])) => dispatchEditor({ type: "sync", update });
  const [workflowId, setWorkflowId] = useState("");
  const [actions, setActions] = useState<ActionDefinition[]>([]);
  const [runs, setRuns] = useState<RunSnapshot[]>([]);
  const [runId, setRunId] = useState("");
  const currentRunId=useRef(runId);currentRunId.current=runId;
  const [runScope, setRunScope] = useState<"workflow" | "all">("workflow");
  const [runWorkflows, setRunWorkflows] = useState<Record<string, WorkflowDefinition>>({});
  const [stepBrowserTargets, setStepBrowserTargets] = useState<Record<string, string>>({});
  const [pageInventory, setPageInventory] = useState<{ runId: string; pages: BrowserPageInfo[]; error?: string }>({ runId: "", pages: [] });
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [actionCategory, setActionCategory] = useState("全部");
  const [inspector, setInspector] = useState<InspectorTab>("step");
  const [runTab, setRunTab] = useState<RunTab>("logs");
  const [rightPane, setRightPane] = useState<"step" | "run">(() => {
    try { return localStorage.getItem("rpa.rightPane") === "run" ? "run" : "step"; }
    catch { return "step"; }
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setErrorMessage] = useState("");
  const [errorDetail, setErrorDetail] = useState<string>();
  const setError = (message: string) => { setErrorMessage(message); setErrorDetail(undefined); };
  const [notice, setNotice] = useState("");
  const [deleteNotice, setDeleteNotice] = useState<{ workflowId: string; count: number }>();
  const [dataDir, setDataDir] = useState("");
  const [maxConcurrent, setMaxConcurrent] = useState(2);
  const [downloadDir, setDownloadDir] = useState("");
  const [demoUrl, setDemoUrl] = useState("");
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [invalidFields, setInvalidFields] = useState<Record<string, boolean>>(
    {},
  );
  const [parameterEdits, setParameterEdits] = useState<Record<string, number>>({});
  const [insertBranch, setInsertBranch] = useState<
    "after" | "children" | "elseSteps"
  >("after");
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    try { localStorage.setItem("rpa.rightPane", rightPane); }
    catch { /* The pane remains usable when preferences cannot be saved. */ }
  }, [rightPane]);
  const workflow = workflows.find((item) => item.workflowId === workflowId);
  const steps = useMemo(
    () => flatten(workflow?.steps ?? []),
    [workflow?.steps],
  );
  const selected = steps.find((item) => item.step.stepId === selectedId);
  const selectedXlsxLoop = (() => {
    let current = selected;
    while (current?.parentId) {
      const parent = steps.find(item => item.step.stepId === current!.parentId);
      if (parent?.step.actionType === "control.forEachXlsx") return parent.step;
      current = parent;
    }
  })();
  const isCommented = (id: string) => {
    let current = steps.find(item => item.step.stepId === id);
    while (current) {
      if (current.step.disabled) return true;
      const parentId = current.parentId;
      current = parentId ? steps.find(item => item.step.stepId === parentId) : undefined;
    }
    return false;
  };
  const selectedCommented = isCommented(selectedId);
  const selectedCatch = useMemo(() => {
    let current = selected;
    while (current?.parentId) {
      const parent = steps.find(item => item.step.stepId === current!.parentId);
      if (current.branch === "elseSteps" && parent?.step.actionType === "control.tryCatch") return parent.step;
      current = parent;
    }
  }, [selected, steps]);
  const selectedAction = actions.find(
    (action) => action.type === selected?.step.actionType,
  );
  const desktopElementSelected = !!selected?.step.actionType.startsWith("windows.");
  const desktopInputSelected = !!selected?.step.actionType.startsWith("desktop.") || desktopElementSelected;
  const availableActions = useMemo(() => actions.filter(action => ![
    "browser.start",
    "browser.switchPage",
  ].includes(action.type)).map(action => advancedActions.has(action.type) ? { ...action, category: '高级采集与校验' } : action), [actions]);
  const run = runs.find((item) => item.runId === runId);
  const runWorkflow = runWorkflows[runId];
  useEffect(() => { if(!api || !run || runTab!=="variables" || !terminalStatuses.has(run.status)) return; let alive=true;const attemptId=run.attemptId;void api.getRunVariables(runId).then(variables=>{if(alive)setRuns(previous=>previous.map(item=>item.runId===runId && item.attemptId===attemptId && terminalStatuses.has(item.status)?{...item,variables}:item));}).catch(catchError);return()=>{alive=false;}; },[runId,runTab,run?.status,run?.attemptId]);
  const stepNames = useMemo(() => new Map(flatten(runWorkflow?.steps ?? []).map(item => [item.step.stepId, item.step.name])), [runWorkflow]);
  const scopedRuns = runScope === "all" ? runs : runs.filter(item => item.workflowId === workflowId);
  const recovery = runRecovery(run, events);
  const history = editorState.histories[workflowId];
  const canUndo = !!history?.past.length;
  const canRedo = !!history?.future.length;
  const dirty = !!workflow && saved[workflowId] !== JSON.stringify(workflow);
  const validationScope = `${workflowId}:${selectedId}:${inspector}:${view}:`;
  const invalid = !(inspector === "step" && selectedCommented) && Object.entries(invalidFields).some(([key, value]) => key.startsWith(validationScope) && value);
  const unfinishedJson = Object.keys(draftTexts[workflowId] ?? {}).filter(key => steps.some(item => key.startsWith(`${item.step.stepId}:`)) || /:(流程默认|子流程输入声明|子流程输出声明)/.test(key));
  const workflowErrors = useMemo(() => workflow ? [...getBrowserPageErrors(workflow), ...getControlStepErrors(workflow), ...getNoteStepErrors(workflow)] : [], [workflow]);
  const invalidWorkflow = invalid || unfinishedJson.length > 0 || workflowErrors.length > 0;
  const activeRun = run && !terminalStatuses.has(run.status);
  const currentActiveRun = activeRun && run.workflowId === workflowId;
  const retainedBrowser = !!run?.browserOpen && !activeRun;
  const browserAvailable = !!activeRun || !!run?.browserOpen;
  const retainedBrowserCount = runs.filter(
    (item) => item.browserOpen && terminalStatuses.has(item.status),
  ).length;
  const workflowRunning = runs.some(
    (item) => item.workflowId === workflowId && !terminalStatuses.has(item.status),
  );
  const stepBrowsers = runs.filter(
    (item) => item.workflowId === workflowId && item.browserOpen && terminalStatuses.has(item.status),
  );
  const stepBrowserTarget = stepBrowserTargets[workflowId] ?? "auto";
  const targetBrowser = stepBrowserTarget === "auto"
    ? stepBrowsers[0]
    : stepBrowsers.find((item) => item.runId === stepBrowserTarget);
  const missingStepBrowser = !["auto", "new"].includes(stepBrowserTarget) && !targetBrowser;
  const pageBrowserId = stepBrowserTarget === "new" ? undefined : runs.find(item =>
    item.workflowId === workflowId && item.browserOpen && (stepBrowserTarget === "auto" || item.runId === stepBrowserTarget))?.runId;
  const browserPages = pageInventory.runId === pageBrowserId ? pageInventory.pages : [];
  const coordinateTarget = String(selected?.step.params.pageId ?? "$current").trim() || "$current";
  const coordinatePage = coordinateTarget === "$current" ? browserPages.find(page => page.current) : browserPages.find(page => page.pageId === coordinateTarget);
  const coordinateUnavailable = !api ? "桌面运行服务未连接。"
    : workflowRunning ? "任务结束后才能获取坐标；可先单步打开目标网页。"
    : !pageBrowserId ? "请先单独运行“打开网页”，并选择保留的浏览器。"
    : workflow?.settings.headless ? "无头浏览器无法取点，请使用有界面浏览器。"
    : coordinateTarget.includes("{{") ? "请先将目标网页改为已打开的具体网页。"
    : !coordinatePage ? "目标网页尚未打开或已关闭，请先打开它。"
    : busy ? "请等待当前操作完成。" : undefined;
  const cannotRunStep = !api || !workflow || !!busy || invalid || workflowRunning || (missingStepBrowser && !desktopInputSelected);
  const stepEvents = events.filter(
    (event) => event.runId === runId && event.type === "step",
  );
  const stepStatuses = new Map(
    stepEvents.map((event) => [event.stepId, event.status]),
  );
  const actionGroups = useMemo(() => {
    const groups = new Map<string, ActionDefinition[]>();
    for (const action of availableActions.filter((item) =>
      (query || actionCategory === "全部" || (actionCategory === '高级' ? advancedActions.has(item.type) : actionCategory === "网页" ? item.type.startsWith("browser.")
        : actionCategory === "软件" ? item.type.startsWith("windows.") || item.type.startsWith("desktop.")
        : ["browser.open", "browser.fill", "browser.click", "core.wait", "core.log", "variables.set"].includes(item.type))) && `${item.label} ${item.type} ${item.description}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )) {
      const group = groups.get(action.category) ?? [];
      group.push(action);
      groups.set(action.category, group);
    }
    return [...groups.entries()].sort((a, b) => Number(b[1].some(item => item.type.startsWith("browser."))) - Number(a[1].some(item => item.type.startsWith("browser."))));
  }, [availableActions, query, actionCategory]);

  useEffect(() => {
    if (runScope === "workflow") setRunId(previous => runs.some(item => item.runId === previous && item.workflowId === workflowId)
      ? previous : runs.find(item => item.workflowId === workflowId)?.runId ?? "");
  }, [workflowId, runScope, runs]);
  useEffect(() => {
    if (!api || !runId) return;
    let disposed = false;
    void api.getRunWorkflow(runId).then(value => {
      if (!disposed && value) setRunWorkflows(previous => ({ ...previous, [runId]: value }));
    }).catch(() => { /* Missing historical context never borrows names from the current draft. */ });
    return () => { disposed = true; };
  }, [runId, run?.revision, run?.stepId,run?.attemptId]);
  useEffect(() => { if (!api || !runId) { setAttempts([]); return; } let alive = true; void api.listAttempts(runId).then(value => { if (alive) setAttempts(value); }).catch(cause => setError(String(cause))); return () => { alive = false; }; }, [runId, run?.attemptId, run?.status]);
  const recoveryKey = recovery && `${runId}:${run?.status}:${recovery.stepId ?? ""}`;
  useEffect(() => {
    if (!recoveryKey) return;
    setPanels(previous => ({ ...previous, right: true }));
    setRightPane("run");
    setRunTab("logs");
  }, [recoveryKey]);
  useEffect(() => {
    if (selectedId) document.querySelector(`[data-step-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedId, workflowId, editorState.restored]);

  useEffect(() => {
    if (!api || !pageBrowserId || view !== "editor") return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const pages = await api.listBrowserPages(pageBrowserId);
        if (!disposed) setPageInventory({ runId: pageBrowserId, pages });
      } catch (cause) {
        if (!disposed) setPageInventory({ runId: pageBrowserId, pages: [], error: cause instanceof Error ? cause.message : String(cause) });
      } finally {
        if (!disposed) timer = setTimeout(() => void refresh(), 1500);
      }
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [pageBrowserId, view]);

  useEffect(() => {
    if (!api) {
      setLoading(false);
      setError(
        "桌面运行服务未连接。请使用项目的桌面启动命令打开应用，浏览器预览无法保存或执行流程。",
      );
      return;
    }
    let mounted = true;let eventTimer:ReturnType<typeof setTimeout>|undefined;const pendingEvents:RunEvent[]=[];
    const flushEvents=()=>{clearTimeout(eventTimer);eventTimer=undefined;if(!mounted)return;const batch=pendingEvents.splice(0);if(!batch.length)return;setEvents(previous=>cacheRunEvents(previous,batch,currentRunId.current));
      setRuns(previous=>{const map=new Map(previous.map(run=>[run.runId,run]));for(const event of batch) if(event.run)map.set(event.runId,mergeRunEvent(map.get(event.runId),event)!);return [...map.values()].sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).map((item,index)=>index>=20 && item.runId!==currentRunId.current && terminalStatuses.has(item.status) && Object.keys(item.variables).length ? {...item,variables:{}} : item);});
      for(const event of batch) if(event.type==='run' && event.status==='queued' && event.data && typeof event.data==='object' && 'workflow' in event.data){const definition=event.data.workflow as WorkflowDefinition;if(definition?.workflowId && Array.isArray(definition.steps))setRunWorkflows(previous=>({...previous,[event.runId]:definition}));}
    };
    const off = api.onEvent((event) => {
      if (!mounted) return;
      pendingEvents.push(event);if(event.run && !['running','queued'].includes(event.run.status))flushEvents();else eventTimer ??=setTimeout(flushEvents,50);
    });
    api
      .bootstrap()
      .then(async (state) => {
        const drafts = await api.listDrafts();
        if (!mounted) return;
        setPendingDrafts(drafts);
        setWorkflows(state.workflows);
        if (!state.workflows.length) setView("workflows");
        setSchedules(state.schedules);
        setOpenFlows(state.workflows[0] ? [state.workflows[0].workflowId] : []);
        setActions(state.actions);
        setRuns((previous) => [
          ...previous,
          ...state.runs.filter(
            (item) => !previous.some((latest) => latest.runId === item.runId),
          ),
        ]);
        setWorkflowId(state.workflows[0]?.workflowId ?? "");
        setSelectedId(state.workflows[0]?.steps[0]?.stepId ?? "");
        setRunId(state.runs.find(item => item.workflowId === state.workflows[0]?.workflowId)?.runId ?? "");
        setSaved(
          Object.fromEntries(
            state.workflows.map((item) => [
              item.workflowId,
              JSON.stringify(item),
            ]),
          ),
        );
        setDataDir(state.dataDir);
        setMaxConcurrent(state.maxConcurrent ?? 2);
        setDownloadDir(state.defaultDownloadDir);
        setDemoUrl(state.demoUrl);
      })
      .catch(
        (cause) =>
          mounted &&
          setError(String(cause instanceof Error ? cause.message : cause)),
      )
      .finally(() => mounted && setLoading(false));
    return () => {
      mounted = false;
      clearTimeout(eventTimer);
      off();
    };
  }, []);

  useEffect(() => {
    localStorage.setItem("rpa.panels", JSON.stringify(panels));
  }, [panels]);
  useEffect(() => {
    if (!api) return;
    void api.getStorageIssues().then(setStorageIssues).catch(cause => setError(String(cause)));
    const offIssues = api.onStorageIssues(setStorageIssues);
    const offFlush = api.onFlushDrafts(() => flushDrafts.current());
    const offFocus = api.onFocusRun(id => { setRunScope('all'); setRunId(id); setView('editor'); setRightPane('run'); setPanels(previous => ({ ...previous, right: true })); });
    return () => { offIssues(); offFlush(); offFocus(); };
  }, []);
  flushDrafts.current = async () => {
    if (!api || loading) return;
    const editable = workflows.filter(flow => !pendingDrafts.some(draft => draft.workflowId === flow.workflowId));
    const drafts = editable.filter(flow => saved[flow.workflowId] !== JSON.stringify(flow) || Object.keys(draftTexts[flow.workflowId] ?? {}).length);
    const clean = editable.filter(flow => !drafts.includes(flow)).map(flow => flow.workflowId);
    const snapshots = drafts.map(flow => ({ workflowId: flow.workflowId, baseRevision: flow.revision, updatedAt: new Date().toISOString(), workflow: clone(flow), selectedId: flow.workflowId === workflowId ? selectedId : '', fieldTexts: draftTexts[flow.workflowId] ?? {} }));
    const operation = draftQueue.current.then(async () => {
      for (const draft of snapshots) { await api!.saveDraft(draft); managedDrafts.current.add(draft.workflowId); }
      // Only clean up drafts written here or explicitly restored; preserve unreadable old files.
      for (const id of clean) if (managedDrafts.current.has(id)) { await api!.discardDraft(id); managedDrafts.current.delete(id); }
    });
    draftQueue.current = operation.catch(() => {}); await operation;
  };
  useEffect(() => {
    if (loading) return;
    firstDraftEditAt.current ??= Date.now();
    const delay = Math.max(0, Math.min(1000, 5000 - (Date.now() - firstDraftEditAt.current)));
    const timer = setTimeout(() => { firstDraftEditAt.current = undefined; void flushDrafts.current().catch(cause => setError(`草稿保存失败：${String(cause)}`)); }, delay);
    return () => clearTimeout(timer);
  }, [workflows, draftTexts, saved, loading]);
  const writeDraftText = (key: string, text?: string) => setDraftTexts(previous => {
    const values = { ...(previous[workflowId] ?? {}) }; if (text === undefined) delete values[key]; else values[key] = text;
    return { ...previous, [workflowId]: values };
  });
  const restoreDraft = async (draft: WorkflowDraft) => {
    const current = workflows.find(flow => flow.workflowId === draft.workflowId);
    const conflict = !!current && current.revision !== draft.baseRevision;
    const restored = conflict ? { ...draft.workflow, workflowId: uuid(), revision: 0, name: `${draft.workflow.name} 恢复副本` } : draft.workflow;
    if(conflict && api) { await api.saveDraft({...draft,workflowId:restored.workflowId,workflow:restored,baseRevision:0,updatedAt:new Date().toISOString()});await api.discardDraft(draft.workflowId); }
    managedDrafts.current.add(restored.workflowId);
    setWorkflows(previous => [...previous.filter(flow => flow.workflowId !== restored.workflowId), restored]);
    setWorkflowId(restored.workflowId); setSelectedId(draft.selectedId); setView('editor'); setInspector('step'); setRightPane('step');
    setDraftTexts(previous => ({ ...previous, [restored.workflowId]: draft.fieldTexts }));
    setPendingDrafts(previous => previous.filter(item => item.workflowId !== draft.workflowId));
  };
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    setInsertBranch("after");
    // Child fields register their initial validity before this effect runs.
    // Keep those entries while discarding drafts from the previous inspector.
    setInvalidFields(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key.startsWith(validationScope))));
  }, [selectedId, workflowId, inspector, view]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const markValid = (key: string, valid: boolean) =>
    setInvalidFields((previous) =>
      previous[`${validationScope}${key}`] === !valid ? previous : { ...previous, [`${validationScope}${key}`]: !valid },
    );
  const updateWorkflow = (
    update: (value: WorkflowDefinition) => WorkflowDefinition, group?: string,
  ) => {
    if (busy) return;
    setDeleteNotice(undefined);
    dispatchEditor({ type: "edit", id: workflowId, update, selectedId, group, at: Date.now() });
  };
  const updateSelected = (update: (step: StepDefinition) => StepDefinition, group?: string) =>
    updateWorkflow((value) => ({
      ...value,
      steps: replaceStep(value.steps, selectedId, update),
    }), group);
  const toggleComments = (ids: string[]) => {
    if (busy || !workflow) return;
    const targets = new Set(ids);
    const selectedSteps = steps.filter(item => targets.has(item.step.stepId));
    if (!selectedSteps.length) return;
    const disabled = !selectedSteps.every(item => item.step.disabled);
    const apply = (items: StepDefinition[]): StepDefinition[] => items.map(step => ({
      ...step,
      ...(targets.has(step.stepId) ? { disabled } : {}),
      ...(step.children ? { children: apply(step.children) } : {}),
      ...(step.elseSteps ? { elseSteps: apply(step.elseSteps) } : {}),
    }));
    updateWorkflow(value => ({ ...value, steps: apply(value.steps) }));
    setNotice(`${disabled ? "已注释" : "已取消注释"} ${selectedSteps.length} 条指令${disabled ? "，运行时将跳过" : ""}`);
  };
  const setParam = (key: string, value: unknown) =>
    updateSelected((step) => {
      const params = { ...step.params };
      if (value === undefined) delete params[key];
      else params[key] = value;
      return { ...step, params };
    }, `param:${selectedId}:${key}`);
  const catchError = (cause: unknown) => {
    const feedback = explainError(cause);
    setErrorMessage(feedback.message); setErrorDetail(feedback.detail);
  };

  function restoreEdit(type: "undo" | "redo") {
    if (busy || !workflow) return;
    const entry = (type === "undo" ? history?.past : history?.future)?.at(-1);
    if (!entry) return;
    dispatchEditor({ type, id: workflowId, selectedId });
    const restoredSteps = flatten(entry.workflow.steps);
    setSelectedId(restoredSteps.some(item => item.step.stepId === entry.selectedId) ? entry.selectedId : restoredSteps[0]?.step.stepId ?? "");
    setInvalidFields({}); setDeleteNotice(undefined); setError("");
    setNotice(type === "undo" ? "已撤销上一次编辑" : "已重做上一次编辑");
  }
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (view !== "editor" && view !== "settings" || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      const target = event.target instanceof Element ? event.target : undefined;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return;
      const key = event.key.toLowerCase();
      if (key === "z" || key === "y") { event.preventDefault(); restoreEdit(key === "y" || event.shiftKey ? "redo" : "undo"); }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [view, busy, workflowId, history, selectedId]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') { event.preventDefault(); void saveWorkflow(); } };
    window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener);
  }, [workflow, busy, invalidWorkflow]);

  function showRunPanel() {
    setRightPane("run"); setView("editor");
    setPanels(previous => ({ ...previous, right: true }));
  }

  function locateRunStep(stepId: string) {
    if (!run) return;
    const target = workflows.find(item => item.workflowId === run.workflowId);
    if (!target || !flatten(target.steps).some(item => item.step.stepId === stepId)) {
      setNotice(`运行中的步骤「${stepNames.get(stepId) ?? stepId}」已不在当前草稿中，请参考本次运行日志。`); return;
    }
    openWorkflow(target.workflowId); setSelectedId(stepId); setInspector("step"); setRightPane("step");
    setPanels(previous => ({ ...previous, right: true }));
  }

  function startExample() {
    if (!workflow || workflow.steps.length || busy) return;
    const sample: StepDefinition[] = [
      { stepId: uuid(), name: "打开演示网页", actionType: "browser.open", params: { url: demoUrl }, onError: "fail" },
      { stepId: uuid(), name: "打印执行说明", actionType: "core.log", params: { message: "演示网页已打开，可以继续添加点击、填写或采集指令。" }, onError: "fail" },
    ];
    updateWorkflow(value => ({ ...value, steps: sample }));
    setSelectedId(sample[0]!.stepId); setInspector("step"); setRightPane("step"); setPanels(previous => ({ ...previous, right: true }));
    setNotice("已添加可运行示例，确认参数后点击运行");
  }

  async function saveWorkflow(thenRun = false) {
    if (!api || !workflow || busy || invalidWorkflow) return;
    setBusy(thenRun ? "run" : "save");
    setError("");
    try {
      if (thenRun) { const issues = await api.preflight(workflow); setPreflightIssues(issues); if (issues.some(issue => issue.level === 'error')) { setError('运行前检查发现错误，请修正后运行。'); return; } }
      const persisted = await api.saveWorkflow(workflow);
      setWorkflows((previous) =>
        previous.map((item) =>
          item.workflowId === persisted.workflowId ? persisted : item,
        ),
      );
      setSaved((previous) => ({
        ...previous,
        [persisted.workflowId]: JSON.stringify(persisted),
      }));
      setDraftTexts(previous => ({ ...previous, [persisted.workflowId]: {} }));
      await draftQueue.current; await api.discardDraft(persisted.workflowId);
      managedDrafts.current.delete(persisted.workflowId);
      if (thenRun) {
        const snapshot = await api.runWorkflow(persisted);
        setRunWorkflows(previous => ({ ...previous, [snapshot.runId]: persisted }));
        setRunScope("workflow");
        setRuns((previous) =>
          previous.some((item) => item.runId === snapshot.runId)
            ? previous
            : [snapshot, ...previous],
        );
        setRunId(snapshot.runId);
        setRunTab("logs");
        showRunPanel();
        setNotice(`已提交运行 · 修订 ${snapshot.revision}`);
      } else setNotice("流程已保存");
    } catch (cause) {
      catchError(cause);
    } finally {
      setBusy("");
    }
  }

  async function control(command: RunCommand) {
    if (!api || !run || busy) return;
    setBusy(command);
    setError("");
    try {
      await api.controlRun(run.runId, command);
    } catch (cause) {
      catchError(cause);
    } finally {
      setBusy("");
    }
  }
  async function startDebug(fromStepId?: string) {
    if (!api || !workflow || busy || invalidWorkflow) return; setBusy('debug'); setError('');
    try {
      const checks = await api.preflight(workflow); setPreflightIssues(checks); if (checks.some(issue => issue.level === 'error')) throw new Error('请修正运行前检查错误');
      const persisted = await api.saveWorkflow(workflow); setWorkflows(previous => previous.map(flow => flow.workflowId === persisted.workflowId ? persisted : flow)); setSaved(previous => ({ ...previous, [persisted.workflowId]: JSON.stringify(persisted) }));
      const snapshot = await api.debugRun(persisted, breakpoints[workflowId] ?? [], fromStepId); setRunId(snapshot.runId); setRuns(previous => [snapshot, ...previous.filter(run => run.runId !== snapshot.runId)]); showRunPanel();
    } catch (error) { catchError(error); } finally { setBusy(''); }
  }

  async function runSingleStep(stepId: string) {
    if (!api || !workflow || cannotRunStep) return;
    const step = steps.find((item) => item.step.stepId === stepId)?.step;
    if (!step || step.actionType === "core.note" || isCommented(stepId)) return;
    const stepWorkflow = { ...workflow, steps: [step] };
    const stepError = [...getBrowserPageErrors(stepWorkflow), ...getControlStepErrors(stepWorkflow), ...getNoteStepErrors(stepWorkflow)][0];
    if (stepError) { setError(`“${stepError.stepName}”：${stepError.error}`); return; }
    setBusy(`step:${stepId}`);
    setError("");
    try {
      const snapshot = await api.runStep(workflow, stepId, step.actionType.startsWith("windows.") ? undefined : targetBrowser?.runId);
      setRunWorkflows(previous => ({ ...previous, [snapshot.runId]: workflow }));
      setRunScope("workflow");
      // Events may arrive before this IPC response; do not replace their newer state.
      setRuns((previous) => previous.some((item) => item.runId === snapshot.runId)
        ? previous : [snapshot, ...previous]);
      setRunId(snapshot.runId);
      if (stepBrowserTarget === "new") setStepBrowserTargets((previous) => ({ ...previous, [workflowId]: "auto" }));
      setSelectedId(stepId);
      setRunTab("logs");
      showRunPanel();
      setNotice(`已提交单条运行：${step.name}`);
    } catch (cause) {
      catchError(cause);
    } finally {
      setBusy("");
    }
  }

  function addAction(action: ActionDefinition, targetId = selectedId, branch = insertBranch) {
    if (!workflow || busy || !availableActions.some(item => item.type === action.type)) return;
    const parent = steps.find(item => item.step.stepId === targetId)?.step;
    if (branch !== "after" && (!parent || !["control.if", "control.forEach", "control.forEachXlsx", "control.tryCatch"].includes(parent.actionType)
      || (branch === "elseSteps" && !["control.if", "control.tryCatch"].includes(parent.actionType)))) return;
    const step: StepDefinition = {
      stepId: uuid(),
      name: action.label,
      actionType: action.type,
      params: clone(action.defaults),
      ...(["core.wait", "core.note"].includes(action.type) ? {} : { timeoutMs: 30000 }),
      ...(action.type === "core.note" ? {} : { onError: action.safeToRetry ? 'fail' as const : 'manual' as const }),
      ...(["control.if", "control.forEach", "control.forEachXlsx", "control.tryCatch"].includes(action.type) ? { children: [] } : {}),
      ...(["control.if", "control.tryCatch"].includes(action.type) ? { elseSteps: [] } : {}),
    };
    updateWorkflow((value) => ({
      ...value,
      steps:
        targetId && steps.some(item => item.step.stepId === targetId)
          ? branch === "after"
            ? changeSiblings(value.steps, targetId, (siblings, index) => [
                ...siblings.slice(0, index + 1),
                step,
                ...siblings.slice(index + 1),
              ])
            : replaceStep(value.steps, targetId, (parent) => ({
                ...parent,
                [branch]: [...(parent[branch] ?? []), step],
              }))
          : [...value.steps, step],
    }));
    setSelectedId(step.stepId);
    setInspector("step"); setRightPane("step");
    setPanels(previous => ({ ...previous, right: true }));
  }

  function mutateStep(id: string, command: "up" | "down" | "copy" | "delete") {
    if (busy) return;
    const original = steps.find((item) => item.step.stepId === id)?.step;
    const copied =
      command === "copy" && original ? copyStep(original) : undefined;
    if (copied) copied.name += " 副本";
    updateWorkflow((value) => ({
      ...value,
      steps: changeSiblings(value.steps, id, (siblings, index) => {
        const items = [...siblings];
        if (command === "delete") items.splice(index, 1);
        if (copied) items.splice(index + 1, 0, copied);
        if (command === "up" && index > 0)
          [items[index - 1], items[index]] = [items[index]!, items[index - 1]!];
        if (command === "down" && index < items.length - 1)
          [items[index], items[index + 1]] = [items[index + 1]!, items[index]!];
        return items;
      }),
    }));
    if (command === "delete" && original && flatten([original]).some(item => item.step.stepId === selectedId)) setSelectedId("");
    if (command === "delete" && original) {
      const count = flatten([original]).length;
      setDeleteNotice({ workflowId, count }); setNotice(`已删除「${original.name}」${count > 1 ? `及其子步骤，共 ${count} 条` : ""}`);
    }
    if (copied) setSelectedId(copied.stepId);
  }

  function createWorkflow() {
    const created: WorkflowDefinition = {
      schemaVersion: 1,
      workflowId: uuid(),
      name: "未命名流程",
      revision: 0,
      variables: {},
      elements: {},
      steps: [],
      settings: { downloadDir, headless: false, keepBrowserOpen: true },
    };
    setWorkflows((previous) => [...previous, created]);
    setWorkflowId(created.workflowId);
    setRunScope("workflow"); setRunId(""); setDeleteNotice(undefined);
    setOpenFlows(previous => [...previous, created.workflowId]);
    setSelectedId("");
    setView("settings");
  }

  function openWorkflow(id: string, destination: typeof view = "editor") {
    const next = workflows.find(item => item.workflowId === id);
    if (!next) return;
    setWorkflowId(id);
    setRunScope("workflow"); setRunId(runs.find(item => item.workflowId === id)?.runId ?? ""); setDeleteNotice(undefined);
    setSelectedId(next.steps[0]?.stepId ?? "");
    setOpenFlows(previous => previous.includes(id) ? previous : [...previous, id]);
    setView(destination);
    setInspector("step"); setRightPane("step");
  }

  function duplicateWorkflow(source: WorkflowDefinition) {
    const copied = { ...clone(source), workflowId: uuid(), name: `${source.name} 副本`, revision: 0, steps: source.steps.map(copyStep) };
    delete copied.settings.profileId;
    setWorkflows(previous => [...previous, copied]);
    setWorkflowId(copied.workflowId); setSelectedId(copied.steps[0]?.stepId ?? "");
    setRunScope("workflow"); setRunId(""); setDeleteNotice(undefined);
    setOpenFlows(previous => [...previous, copied.workflowId]); setView("settings");
    setNotice("已复制流程，保存后可运行");
  }

  async function deleteWorkflow(flow: WorkflowDefinition) {
    if (!api || busy) return;
    setBusy("delete"); setError("");
    try {
      if (flow.revision > 0) await api.deleteWorkflow(flow.workflowId);
      setWorkflows(previous => previous.filter(item => item.workflowId !== flow.workflowId));
      setOpenFlows(previous => previous.filter(id => id !== flow.workflowId));
      setSchedules(previous => previous.filter(item => item.workflowId !== flow.workflowId));
      if (workflowId === flow.workflowId) { const next = workflows.find(item => item.workflowId !== flow.workflowId); setWorkflowId(next?.workflowId ?? ""); setSelectedId(next?.steps[0]?.stepId ?? ""); }
      setNotice("流程及关联定时任务已删除，运行历史已保留");
    } catch (cause) { catchError(cause); } finally { setBusy(""); }
  }

  function dropAction(event: React.DragEvent, targetId: string) {
    event.preventDefault();
    const action = availableActions.find(item => item.type === event.dataTransfer.getData("application/x-rpa-action"));
    if (action) addAction(action, targetId, "after");
  }

  const tabs: {
    id: RunTab;
    label: string;
    shortLabel: string;
    icon: ReactNode;
    count?: number;
  }[] = [
    { id: "logs", label: "运行日志", shortLabel: "日志", icon: <Terminal size={15} /> },
    { id: "variables", label: "变量", shortLabel: "变量", icon: <Braces size={15} /> },
    {
      id: "artifacts",
      label: "下载产物",
      shortLabel: "文件",
      icon: <Download size={15} />,
      count: run?.artifacts.length,
    },
    {
      id: "runs",
      label: "全部运行",
      shortLabel: "历史",
      icon: <Layers size={15} />,
      count: runs.length,
    },
  ];

  return (
    <DraftContext.Provider value={{ texts: draftTexts[workflowId] ?? {}, scope: `${selectedId}:${inspector}`, write: writeDraftText }}>
    <div className={`app-shell${recovery ? " has-recovery" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Workflow size={21} />
          </span>
          <div>
            <strong>本地 RPA</strong>
            <span>流程工作台</span>
          </div>
        </div>
        <div className="workflow-heading">
          <span className="breadcrumb">
            我的流程 <ChevronRight size={14} />
          </span>
          <h1>{workflow?.name ?? "流程编辑器"}</h1>
          <span className="revision">v{workflow?.revision ?? 0}</span>
          {dirty && <span className="unsaved">未保存</span>}
        </div>
        <div className="toolbar">
          <button
            disabled={!api || !workflow || !!busy || invalidWorkflow}
            onClick={() => void saveWorkflow()}
          >
            <Save size={16} />
            {busy === "save" ? "保存中" : "保存"}
          </button>
          <button
            className="primary"
            disabled={
              !api || !workflow || !!busy || invalidWorkflow || !workflow.steps.length
            }
            title={
              !workflow?.steps.length
                ? "添加至少一个步骤后运行"
                : "保存当前流程并运行"
            }
            onClick={() => void saveWorkflow(true)}
          >
            {busy === "run" ? (
              <Loader2 className="spin" size={16} />
            ) : (
              <Play size={16} />
            )}
            运行
          </button>
          <button
            className="top-run-control"
            title={`控制当前流程的所选运行${run?.workflowId === workflowId ? ` · ${run.runId.slice(0, 8)}` : ""}；当前步骤完成后暂停`}
            disabled={!currentActiveRun || !!busy || run?.status === "queued" || run?.manualDecisionRequired}
            onClick={() =>
              void control(
                run?.status === "paused" || run?.status === "waiting_manual"
                  ? "resume"
                  : "pause",
              )
            }
          >
            {run?.status === "paused" || run?.status === "waiting_manual" ? (
              <Play size={16} />
            ) : (
              <Pause size={16} />
            )}
            {run?.status === "paused" || run?.status === "waiting_manual"
              ? "继续"
              : "暂停"}
          </button>
          <button
            className="top-run-control"
            title={`停止当前流程的所选运行${run?.workflowId === workflowId ? ` · ${run.runId.slice(0, 8)}` : ""}`}
            disabled={!currentActiveRun || !!busy}
            onClick={() => void control("stop")}
          >
            <Square size={14} />
            停止
          </button>
        </div>
      </header>

      {!!pendingDrafts.length && <div className="draft-recovery" role="region" aria-label="草稿恢复">{pendingDrafts.map(draft => <div key={draft.workflowId}><span>未保存草稿：{draft.workflow.name} · {new Date(draft.updatedAt).toLocaleString('zh-CN')}{workflows.some(flow => flow.workflowId === draft.workflowId && flow.revision !== draft.baseRevision) ? ' · 保存版本已变化，将恢复为副本' : ''}</span><button onClick={() => void restoreDraft(draft).catch(catchError)}>恢复草稿</button><button onClick={() => void api?.discardDraft(draft.workflowId).then(() => setPendingDrafts(previous => previous.filter(item => item.workflowId !== draft.workflowId))).catch(cause => setError(String(cause)))}>放弃草稿</button></div>)}</div>}
      {!!storageIssues.length && <div className="alert" role="alert"><AlertCircle size={17}/><span>保存异常：{storageIssues.map(issue => issue.message).join('；')}</span><button onClick={() => void api?.retryStorage().then(setStorageIssues).catch(cause => setError(String(cause)))}>重试保存</button></div>}
      {error && (
        <div className="alert" role="alert">
          <AlertCircle size={17} />
          <span>{error}</span>
          {errorDetail && <details className="error-detail"><summary>技术详情</summary><pre>{errorDetail}</pre></details>}
          <button className="text-button" onClick={() => { setError(""); if (workflow) setView("editor"); }}>返回编辑</button>
          <IconButton label="关闭提示" onClick={() => setError("")}>
            <X size={16} />
          </IconButton>
        </div>
      )}
      {!!preflightIssues.length && <details className="preflight-report"><summary>运行前检查 · {preflightIssues.filter(issue => issue.level === 'error').length} 个错误，{preflightIssues.filter(issue => issue.level === 'warning').length} 个提醒</summary>{preflightIssues.map((issue, index) => <p key={index}><strong>{issue.level === 'error' ? '错误' : '提醒'}</strong>：{issue.message}{issue.stepId && <button onClick={() => { setSelectedId(issue.stepId!); setView('editor'); setRightPane('step'); }}>定位步骤</button>}</p>)}</details>}
      {!!unfinishedJson.length && ["editor", "settings"].includes(view) && <div className="alert page-validation" role="status"><AlertCircle size={17} /><span>流程中有未完成的 JSON，请修正后再保存、运行或调试。</span></div>}
      {workflowErrors[0] && ["editor", "settings"].includes(view) && <div className="alert page-validation" role="status">
        <AlertCircle size={17} />
        <span>“{workflowErrors[0].stepName}”：{workflowErrors[0].error}{workflowErrors.length > 1 ? `（另有 ${workflowErrors.length - 1} 项待完善）` : ""}</span>
        <button className="text-button" onClick={() => {
          setSelectedId(workflowErrors[0].stepId); setInspector("step"); setRightPane("step"); setView("editor"); setPanels(previous => ({ ...previous, right: true }));
        }}>定位步骤</button>
      </div>}
      {notice && (
        <div className="toast" role="status">
          <Check size={16} />
          {notice}
          {deleteNotice?.workflowId === workflowId && canUndo && <button className="text-button" onClick={() => restoreEdit("undo")}><Undo2 size={14} />撤销删除</button>}
          <IconButton label="关闭通知" onClick={() => setNotice("")}>
            <X size={14} />
          </IconButton>
        </div>
      )}

      <nav className="workspace-nav" aria-label="工作空间导航">
        <button aria-current={view === "workflows" ? "page" : undefined} onClick={() => setView("workflows")}><Layers size={16} />流程管理<span className="count">{workflows.length}</span></button>
        <button aria-current={view === "editor" || view === "settings" ? "page" : undefined} disabled={!workflow} onClick={() => setView("editor")}><Workflow size={16} />流程编辑器</button>
        <button aria-current={view === "schedules" ? "page" : undefined} onClick={() => setView("schedules")}><CalendarClock size={16} />定时运行</button>
        <div className="panel-controls" aria-label="面板布局">
          <button aria-label={panels.left ? "收起左侧栏" : "展开左侧栏"} title={panels.left ? "收起左侧栏" : "展开左侧栏"} aria-expanded={panels.left} onClick={() => setPanels(value => ({ ...value, left: !value.left }))}>{panels.left ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}</button>
          <button aria-label={panels.right ? "收起右侧栏" : "展开右侧栏"} title={panels.right ? "收起右侧栏" : "展开右侧栏"} aria-expanded={panels.right} onClick={() => setPanels(value => ({ ...value, right: !value.right }))}>{panels.right ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}</button>
          <button aria-label="查看运行结果" title="在右侧查看日志、变量、文件和历史运行" aria-pressed={view === "editor" && panels.right && rightPane === "run"} onClick={() => { setView("editor"); setRightPane("run"); setPanels(value => ({ ...value, right: true })); }}><Terminal size={17} /></button>
        </div>
      </nav>
      {view === "workflows" && <WorkflowsPage workflows={workflows} saved={saved} busy={loading || !!busy || !api} onCreate={createWorkflow} onOpen={openWorkflow} onSettings={id => openWorkflow(id, "settings")} onCopy={duplicateWorkflow} onDelete={deleteWorkflow} />}
      {view === "schedules" && api && <Suspense fallback={<p>正在读取调度界面…</p>}><SchedulesPage api={api} workflows={workflows} runs={runs} initial={schedules} onError={catchError} /></Suspense>}
                  {view === "settings" && workflow && (
              <main className="management-page settings-page" aria-label="流程运行设置" key={workflowId}><div className="settings-content"><button className="text-button" onClick={() => setView("editor")}><ChevronRight size={15} />返回流程编辑器</button>
                <h2 className="panel-title">运行设置</h2>
                <p className="help-text">
                  设置随流程保存，在下一次运行时生效。
                </p>
                <label className="field">
                  <span>流程名称</span>
                  <input
                    value={workflow.name}
                    disabled={!!busy}
                    onChange={(event) =>
                      updateWorkflow((value) => ({
                        ...value,
                        name: event.target.value,
                      }))
                    }
                  />
                </label>
                <label className="field">
                  <span>下载目录</span>
                  <div className="input-with-button">
                    <input
                      value={workflow.settings.downloadDir}
                      disabled={!!busy}
                      placeholder={downloadDir}
                      onChange={(event) =>
                        updateWorkflow((value) => ({
                          ...value,
                          settings: {
                            ...value.settings,
                            downloadDir: event.target.value,
                          },
                        }))
                      }
                    />
                    <IconButton
                      label="选择下载目录"
                      disabled={!api || !!busy}
                      onClick={() =>
                        void api
                          ?.chooseDirectory()
                          .then((path) => {
                            if (path)
                              updateWorkflow((value) => ({
                                ...value,
                                settings: {
                                  ...value.settings,
                                  downloadDir: path,
                                },
                              }));
                          })
                          .catch(catchError)
                      }
                    >
                      <FolderOpen size={17} />
                    </IconButton>
                  </div>
                  <small>下载产物保留本次运行的独立归属。</small>
                </label>
                <label className="field">
                  <span>浏览器运行方式</span>
                  <select
                    value={workflow.settings.headless ? "headless" : "headed"}
                    disabled={!!busy}
                    onChange={(event) =>
                      updateWorkflow((value) => ({
                        ...value,
                        settings: {
                          ...value.settings,
                          headless: event.target.value === "headless",
                        },
                      }))
                    }
                  >
                    <option value="headed">
                      有界面 · 支持人工接管与最小化
                    </option>
                    <option value="headless">无头 · 不显示浏览器窗口</option>
                  </select>
                  <small>人工登录使用有界面模式；运行时不能切换模式。</small>
                </label>
                <label className="field">
                  <span>智能屏蔽弹窗</span>
                  <select
                    aria-label="智能屏蔽弹窗"
                    value={workflow.settings.popupPolicy ?? "smart"}
                    disabled={!!busy}
                    onChange={(event) => updateWorkflow((value) => ({
                      ...value,
                      settings: { ...value.settings, popupPolicy: event.target.value as "off" | "smart" | "strict" },
                    }))}
                  >
                    <option value="smart">智能屏蔽（默认）</option>
                    <option value="strict">强力屏蔽</option>
                    <option value="off">关闭屏蔽</option>
                  </select>
                  <small>智能模式处理广告、营销、Cookie 弹层和脚本弹窗，尽量保留登录及业务窗口。强力模式也屏蔽通用遮罩和额外弹出窗口。</small>
                  <small>保存后下次运行生效；也可添加「智能屏蔽弹窗」指令，在当前浏览器中切换。被屏蔽的确认框会取消，不会自动确认业务操作。</small>
                </label>
                <label className="field">
                  <span>流程结束后的浏览器</span>
                  <select
                    value={workflow.settings.keepBrowserOpen !== false ? "keep" : "close"}
                    disabled={!!busy}
                    onChange={(event) =>
                      updateWorkflow((value) => ({
                        ...value,
                        settings: {
                          ...value.settings,
                          keepBrowserOpen: event.target.value === "keep",
                        },
                      }))
                    }
                  >
                    <option value="keep">保留浏览器（默认）</option>
                    <option value="close">自动关闭浏览器</option>
                  </select>
                  <small>
                    保留后仍占用资源，可在运行记录中显示、最小化或手动关闭。停止任务会关闭浏览器。
                  </small>
                </label>
                <label className="field">
                  <span>浏览器配置名称</span>
                  <input
                    value={workflow.settings.profileId ?? ""}
                    disabled={!!busy}
                    placeholder="留空使用独立运行配置"
                    onChange={(event) =>
                      updateWorkflow((value) => ({
                        ...value,
                        settings: {
                          ...value.settings,
                          profileId: event.target.value || undefined,
                        },
                      }))
                    }
                  />
                  <small>
                    命名配置可保留登录。同一配置同时只供一个任务使用；再次使用前，请关闭保留的浏览器。
                  </small>
                </label>
                <label className="field">
                  <span>Python 可执行文件</span>
                  <input
                    value={workflow.settings.pythonExecutable ?? ""}
                    disabled={!!busy}
                    placeholder="python"
                    onChange={(event) =>
                      updateWorkflow((value) => ({
                        ...value,
                        settings: {
                          ...value.settings,
                          pythonExecutable: event.target.value || undefined,
                        },
                      }))
                    }
                  />
                  <small>Python 步骤调用本地环境，不自动安装依赖。</small>
                </label>
                <label className="field"><span>操作电脑前的用户空闲时间（秒）</span><input type="number" min="0" max="60" value={(workflow.settings.foregroundIdleMs ?? 3000) / 1000} disabled={!!busy} onChange={event => updateWorkflow(value => ({ ...value, settings: { ...value.settings, foregroundIdleMs: Number(event.target.value) * 1000 } }))}/></label>
                <label className="field"><span>前台资源最长等待（分钟）</span><input type="number" min="1" max="60" value={(workflow.settings.foregroundWaitMs ?? 900000) / 60000} disabled={!!busy} onChange={event => updateWorkflow(value => ({ ...value, settings: { ...value.settings, foregroundWaitMs: Number(event.target.value) * 60000 } }))}/><small>等待不消耗动作超时。用户输入或窗口变化后，请检查现场并选择人工恢复决策。Ctrl+Alt+F12 停止全部任务。</small></label>
                {dataDir && (
                  <div className="environment-info">
                    <span>本地数据目录</span>
                    <code>{dataDir}</code>
                    <button
                      className="text-button"
                      onClick={() =>
                        void api?.openPath(dataDir).catch(catchError)
                      }
                    >
                      <FolderOpen size={14} />
                      打开目录
                    </button>
                  </div>
                )}
                {api && <RevisionHistory api={api} workflow={workflow} beforeRestore={async () => { await flushDrafts.current(); setPendingDrafts(await api.listDrafts()); }} onError={catchError} onRestore={persisted => { setWorkflows(previous => previous.map(flow => flow.workflowId === persisted.workflowId ? persisted : flow)); setSaved(previous => ({ ...previous, [persisted.workflowId]: JSON.stringify(persisted) })); setDraftTexts(previous => ({ ...previous, [persisted.workflowId]: {} })); setNotice(`已恢复为 v${persisted.revision}`); }} />}
                {demoUrl && (
                  <div className="environment-info">
                    <span>受控演示页</span>
                    <code>{demoUrl}</code>
                    <small>
                      示例用于验证自动化闭环，不代表真实站点已适配。
                    </small>
                  </div>
                )}
              <details className="advanced"><summary>流程默认变量、元素与子流程声明</summary><JsonEditor label="子流程输入声明（JSON变量名数组）" value={workflow.inputs ?? []} disabled={!!busy} onValidity={valid => markValid("workflow-inputs",valid)} onChange={value => updateWorkflow(item => ({...item,inputs:value as string[]}))}/><JsonEditor label="子流程输出声明（JSON变量名数组）" value={workflow.outputs ?? []} disabled={!!busy} onValidity={valid => markValid("workflow-outputs",valid)} onChange={value => updateWorkflow(item => ({...item,outputs:value as string[]}))}/><p className="help-text">每条指令可在右侧配置自己的覆盖值。此处保留已有流程的默认配置。</p><JsonEditor label="流程默认变量 JSON" value={workflow.variables} objectOnly disabled={!!busy} onValidity={valid => markValid("workflow-variables", valid)} onChange={value => updateWorkflow(item => ({ ...item, variables: value as WorkflowDefinition["variables"] }))} /><JsonEditor label="流程默认元素 JSON" value={workflow.elements} objectOnly disabled={!!busy} onValidity={valid => markValid("workflow-elements", valid)} onChange={value => updateWorkflow(item => ({ ...item, elements: value as WorkflowDefinition["elements"] }))} /></details></div></main>
            )}

      <div className={`workspace${panels.left ? "" : " left-collapsed"}${panels.right ? "" : " right-collapsed"}`} hidden={view !== "editor"}>
        <aside className="library" aria-label="指令库">
          <div className="workflow-picker">
            <label htmlFor="workflow-picker">当前流程</label>
            <div>
              <select
                id="workflow-picker"
                value={workflowId}
                disabled={loading || !!busy}
                onChange={(event) => {
                  openWorkflow(event.target.value);
                }}
              >
                <option value="" disabled>
                  选择流程
                </option>
                {workflows.map((item) => (
                  <option key={item.workflowId} value={item.workflowId}>
                    {item.name}
                  </option>
                ))}
              </select>
              <IconButton
                label="新建流程"
                disabled={!api || loading || !!busy}
                onClick={createWorkflow}
              >
                <Plus size={18} />
              </IconButton>
            </div>
          </div>
          <div className="section-heading">
            <h2>指令库</h2>
            <span>{availableActions.length}</span>
          </div>
          <label className="search">
            <Search size={16} />
            <input
              ref={searchRef}
              aria-label="搜索指令"
              placeholder="搜索指令"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <kbd>Ctrl K</kbd>
          </label>
          <div className="library-categories" role="group" aria-label="指令类别">
            {["全部", "常用", "网页", "软件", "高级"].map(category => <button key={category} aria-pressed={actionCategory === category}
              onClick={() => { setActionCategory(category); setQuery(""); }}>{category}</button>)}
          </div>
          <div className="action-groups">
            {loading ? (
              <div className="skeleton-list" aria-label="加载指令库">
                {[1, 2, 3, 4, 5].map((item) => (
                  <div key={item} />
                ))}
              </div>
            ) : actionGroups.length ? (
              actionGroups.map(([category, items]) => (
                <ActionLibraryGroup key={category} category={category}>
                  {category === "键盘和鼠标操作" && <p className="action-group-notice" role="note">
                    会抢夺鼠标和键盘，操作当前前台窗口；可用于电脑中的任意软件或网页。运行时请勿同时操作电脑。
                  </p>}
                  {items.map((action) => (
                    <button
                      type="button"
                      className="library-action"
                      key={action.type}
                      disabled={!workflow || !!busy}
                      title={`${action.description}\n\n点击添加到选中步骤之后，也可以拖拽到目标步骤。`}
                      draggable={!busy}
                      onDragStart={event => { event.dataTransfer.setData("application/x-rpa-action", action.type); event.dataTransfer.effectAllowed = "copy"; }}
                      onClick={() => addAction(action)}
                    >
                      <span className="action-icon">
                        <ActionIcon type={action.type} />
                      </span>
                      <span>{action.label}</span>
                      <Plus size={14} className="add-sign" />
                    </button>
                  ))}
                </ActionLibraryGroup>
              ))
            ) : (
              <div className="subtle-empty">
                {query ? "没有匹配的指令" : "连接桌面服务后加载指令"}
              </div>
            )}
          </div>
          <div className="library-footer">
            <span className="local-dot" />
            本机执行<span>数据保存在本地</span>
          </div>
        </aside>

        <main className="editor">
          <div className="workflow-tabs" aria-label="已打开流程">{openFlows.map(id => { const flow = workflows.find(item => item.workflowId === id); return flow && <div className={workflowId === id ? "active" : ""} key={id}><button aria-pressed={workflowId === id} onClick={() => openWorkflow(id)} title={flow.name}>{flow.name}{saved[id] !== JSON.stringify(flow) && <span className="draft-dot" />}</button><button aria-label={`关闭标签 ${flow.name}`} title="只关闭标签，草稿仍在流程管理中" onClick={() => { const remaining = openFlows.filter(item => item !== id); setOpenFlows(remaining); if (id === workflowId) { if (remaining[0]) openWorkflow(remaining[0]); else setView("workflows"); } }}><X size={12} /></button></div>; })}</div>
          <div className="editor-top">
            <div>
              <ListTree size={17} />
              <h2>流程步骤</h2>
              <span className="count">{steps.length}</span>
            </div>
            <div className="editor-history" aria-label="编辑历史">
              <button disabled={!!busy} onClick={() => void api?.preflight(workflow!).then(setPreflightIssues).catch(catchError)}>运行前检查</button>
              <IconButton label="撤销编辑" title="撤销编辑（Ctrl+Z；输入框内使用文本撤销）" disabled={!canUndo || !!busy} onClick={() => restoreEdit("undo")}><Undo2 size={16} /></IconButton>
              <IconButton label="重做编辑" title="重做编辑（Ctrl+Y 或 Ctrl+Shift+Z）" disabled={!canRedo || !!busy} onClick={() => restoreEdit("redo")}><Redo2 size={16} /></IconButton>
            </div>
            <details className="debug-tools"><summary>调试</summary><div><button disabled={!!busy || invalidWorkflow || workflowRunning} onClick={() => void startDebug()}>按断点调试</button><button disabled={!!busy || invalidWorkflow || workflowRunning || !workflow?.steps.some(step => step.stepId === selectedId)} onClick={() => void startDebug(selectedId)}>从选中顶层步骤调试</button><button disabled={!selectedId || !!busy} onClick={() => setBreakpoints(previous => { const current = previous[workflowId] ?? []; return { ...previous, [workflowId]: current.includes(selectedId) ? current.filter(id => id !== selectedId) : [...current, selectedId] }; })}>{breakpoints[workflowId]?.includes(selectedId) ? '取消当前断点' : '设置当前断点'}</button><p>断点：{breakpoints[workflowId]?.map(id => steps.find(item => item.step.stepId === id)?.step.name ?? id).join('、') || '无'}</p></div></details>
            <button
              className="text-button"
              disabled={!workflow}
              onClick={() => setView("settings")}
            >
              <Settings2 size={15} />
              运行设置
            </button>
          </div>
          {workflow && steps.length > 0 && (selected?.step.actionType === "core.note" ? <div className="single-step-toolbar" aria-label="备注说明">
            <p>备注用于说明流程，运行时会直接跳过，不操作浏览器，也不会产生输出变量。</p>
          </div> : <div className="single-step-toolbar" aria-label="单条运行">
            <div className="single-step-controls">
              {!desktopInputSelected && <><label htmlFor="step-browser-target"><Globe size={15} />目标浏览器</label>
              <select
                id="step-browser-target"
                aria-label="单条运行的目标浏览器"
                value={stepBrowserTarget}
                disabled={!!busy || workflowRunning}
                onChange={(event) => setStepBrowserTargets((previous) => ({ ...previous, [workflowId]: event.target.value }))}
              >
                <option value="auto">{stepBrowsers[0] ? `当前流程 · ${stepBrowsers[0].runId.slice(0, 8)}` : "自动 · 首次打开时新建"}</option>
                <option value="new">新建浏览器会话</option>
                {stepBrowsers.map((item) => <option key={item.runId} value={item.runId}>
                  {formatTime(item.startedAt)} · {item.runId.slice(0, 8)}
                </option>)}
                {missingStepBrowser && <option value={stepBrowserTarget}>所选浏览器不可用</option>}
              </select></>}
              <button
                className="single-step-run"
                disabled={cannotRunStep || !selected || selectedCommented}
                onClick={() => selected && void runSingleStep(selected.step.stepId)}
              >
                {busy.startsWith("step:") ? <Loader2 size={15} className="spin" /> : <Play size={15} />}
                运行选中指令
              </button>
            </div>
            <p role={missingStepBrowser ? "status" : undefined}>
              {selectedCommented ? "此指令已注释或位于已注释的容器中，取消注释后可运行。"
                : workflowRunning ? "当前流程正在执行，请等待完成或停止后再单条运行。"
                : missingStepBrowser && !desktopInputSelected ? "所选浏览器已关闭或不可用，请重新选择目标。"
                : selectedCatch ? `此指令位于「${selectedCatch.name}」的 Catch 内；单独运行不会生成异常变量，引用异常信息时请运行所在的 Try / Catch。`
                : selected?.step.actionType === "core.wait" ? "等待无需浏览器；等待结束后继续下一步，可随时停止运行。"
                : selected?.step.actionType === "control.tryCatch" ? "运行整个 Try / Catch；Try 出错后执行 Catch，异常变量仅在 Catch 执行期间可用。"
                : selected?.step.actionType === "core.log" ? "使用当前参数；打印日志无需浏览器。引用循环当前项时，请运行整个循环。"
                : desktopElementSelected ? "按保存的窗口与控件条件定位；模拟操作会激活目标窗口并占用真实键鼠。"
                : desktopInputSelected ? "操作电脑当前前台窗口，会占用真实鼠标和键盘；运行时请勿同时操作电脑。"
                : selected?.step.actionType === "control.forEachXlsx" ? "运行整个 XLSX 循环；每行执行一次循环体，无需先打开浏览器。"
                : "使用当前参数；网页指令先运行「打开网页」，后续复用浏览器。容器会执行其子步骤。"}
            </p>
            {pageBrowserId && <p className="browser-page-status" role="status">
              {pageInventory.runId === pageBrowserId && pageInventory.error
                ? `网页列表暂不可用：${pageInventory.error}`
                : `已登记 ${browserPages.length} 个网页 · 当前：${browserPages.find(page => page.current)?.pageId ?? "尚未选定或已关闭"}`}
            </p>}
          </div>)}
          <div className="editor-caption" hidden={!steps.length}>
            <span>内部指令按层级缩进；点击分支内的 + 添加指令</span>
            {selected && (
              <select
                className="insert-select"
                aria-label="新指令插入位置"
                value={insertBranch}
                onChange={(event) =>
                  setInsertBranch(event.target.value as typeof insertBranch)
                }
              >
                <option value="after">插入到选中步骤之后</option>
                {["control.if", "control.forEach", "control.forEachXlsx", "control.tryCatch"].includes(selected.step.actionType) && (
                  <option value="children">{["control.forEach", "control.forEachXlsx"].includes(selected.step.actionType) ? "添加到循环体" : selected.step.actionType === "control.tryCatch" ? "添加到 Try 执行区" : "添加到满足条件"}</option>
                )}
                {["control.if", "control.tryCatch"].includes(selected.step.actionType) && (
                  <option value="elseSteps">{selected.step.actionType === "control.tryCatch" ? "添加到 Catch 异常区" : "添加到否则分支"}</option>
                )}
              </select>
            )}
          </div>
          <div className="step-scroll" onDragOver={event => { if (event.dataTransfer.types.includes("application/x-rpa-action")) event.preventDefault(); }} onDrop={event => dropAction(event, "")}>
            {loading ? (
              <div className="skeleton-steps" aria-label="正在加载流程">
                {[1, 2, 3, 4].map((item) => (
                  <div key={item} />
                ))}
              </div>
            ) : steps.length ? (
              <div className="step-list">
                <div className="flow-terminal">
                  <span />
                  <span>开始</span>
                </div>
                <StepTree
                  key={workflowId}
                  steps={workflow?.steps ?? []}
                  actions={availableActions}
                  selectedId={selectedId}
                  disabled={!!busy}
                  cannotRun={cannotRunStep}
                  statuses={run?.workflowId === workflowId ? new Map([
                    ...stepStatuses,
                    ...(run.currentStepId && activeRun ? [[run.currentStepId, run.status] as const] : []),
                  ]) : new Map()}
                  renderIcon={type => <ActionIcon type={type} size={19} />}
                  renderStatus={status => <Status status={status} />}
                  onSelect={id => { setSelectedId(id); setInspector("step"); setRightPane("step"); setPanels(previous => ({ ...previous, right: true })); }}
                  onRun={id => void runSingleStep(id)}
                  onToggleComment={toggleComments}
                  onMutate={mutateStep}
                  onAdd={addAction}
                  onBatch={(ids, command, target) => { try { const next = editSelectedSteps(workflow?.steps ?? [], ids, command, target); updateWorkflow(flow => ({ ...flow, steps: next })); if (command === 'delete') setSelectedId(''); } catch (error) { catchError(error); } }}
                />
                <div className="flow-terminal end">
                  <span />
                  <span>结束</span>
                </div>
              </div>
            ) : (
              <div className="empty-editor">
                <span className="empty-icon">
                  <Workflow size={32} />
                </span>
                <h3>{workflow ? "搭建第一个步骤" : "连接你的流程工作台"}</h3>
                <p>
                  {workflow
                    ? "网页任务从打开网页开始；已有目标软件时，可浏览软件指令。"
                    : "请从 Electron 桌面应用启动，以加载流程和运行服务。"}
                </p>
                {workflow && (
                  <div className="empty-start-actions">
                    <button className="primary" disabled={!!busy || !availableActions.some(action => action.type === "browser.open")} onClick={() => {
                      const action = availableActions.find(item => item.type === "browser.open");
                      if (action) addAction(action);
                    }}><Globe size={16} />添加打开网页</button>
                    <button disabled={!!busy || !demoUrl} onClick={startExample}><Play size={16} />使用可运行示例</button>
                    <button className="text-button" onClick={() => { setActionCategory("软件"); setQuery(""); setPanels(previous => ({ ...previous, left: true })); searchRef.current?.focus(); }}><Search size={16} />浏览软件指令</button>
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="editor-bottom">
            <span>
              <Circle size={8} fill="currentColor" />
              {workflow
                ? dirty
                  ? "草稿有未保存更改"
                  : "流程已保存"
                : "等待桌面服务"}
            </span>
            <span>整流程使用保存版本 · 单条使用当前参数</span>
          </div>
        </main>

        <aside className="inspector" aria-label="参数与设置">
          <div className="right-pane-switch" role="group" aria-label="右侧栏内容">
            <button aria-pressed={rightPane === "step"} aria-controls="step-editor-panel" onClick={() => setRightPane("step")}><Settings2 size={15} />步骤编辑</button>
            <button aria-label="运行结果" aria-pressed={rightPane === "run"} aria-controls="run-monitor-panel" onClick={() => setRightPane("run")}><Terminal size={15} />运行结果{run && <span className={`pane-status pane-status-${run.status}`} title={statusLabels[run.status]} aria-label={statusLabels[run.status]} />}</button>
          </div>
          <div className="step-editor-panel" id="step-editor-panel" hidden={rightPane !== "step"}>
          <nav className="inspector-tabs" aria-label="属性面板">
            {(
              [
                { id: "step", label: "步骤参数" },
                { id: "settings", label: "设置" },
                { id: "inputs", label: "变量" },
                { id: "elements", label: "元素" },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                aria-current={inspector === tab.id ? "page" : undefined}
                onClick={() => setInspector(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
          <div className="inspector-context"><span>当前指令</span><strong>{selected?.step.name ?? "未选择"}</strong></div>
          <div className="inspector-body" key={`${workflowId}:${selectedId}:${view}:${editorState.restored}`}>
            {inspector === "step" &&
              (selected ? (
                <>
                  <div className="inspector-title">
                    <span className="step-action-icon">
                      <ActionIcon type={selected.step.actionType} size={21} />
                    </span>
                    <div>
                      <h2>
                        {selectedAction?.label ?? selected.step.actionType}
                      </h2>
                      <span>{selected.step.actionType}</span>
                    </div>
                  </div>
                  <p className="help-text action-description">
                    {selectedAction?.description ??
                      "此动作没有可用的参数定义，可在下方编辑原始 JSON 参数。"}
                  </p>
                  {selectedAction?.category === "键盘和鼠标操作" && <p className="help-text desktop-input-notice" role="note">
                    此指令会抢夺真实鼠标和键盘，作用于当前前台窗口；可操作任意软件或网页。运行时请勿同时操作电脑。
                  </p>}
                  <label className="field">
                    <span>步骤名称</span>
                    <input
                      value={selected.step.name}
                      disabled={!!busy}
                      onChange={(event) =>
                        updateSelected((step) => ({
                          ...step,
                          name: event.target.value,
                        }))
                      }
                    />
                  </label>
                  {workflow && ["control.if", "control.forEach", "control.forEachXlsx", "control.tryCatch", "core.wait"].includes(selected.step.actionType) ? (
                    <ControlFlowFields
                      key={selectedId}
                      api={api}
                      workflow={workflow}
                      step={selected.step}
                      disabled={!!busy}
                      onChange={params => updateSelected(step => ({ ...step, params }))}
                      onValidity={markValid}
                    />
                  ) : selected.step.actionType === "core.note" ? (
                    <NoteFields step={selected.step} disabled={!!busy} onChange={params => updateSelected(step => ({ ...step, params }))} onValidity={markValid} />
                  ) : workflow && selected.step.actionType === "browser.open" ? (
                    <BrowserOpenFields workflow={workflow} step={selected.step} pages={browserPages} disabled={!!busy}
                      onChange={params => updateSelected(step => ({ ...step, params }))} onValidity={markValid} />
                  ) : workflow && selected.step.actionType === "browser.closePage" ? (
                    <BrowserCloseFields workflow={workflow} step={selected.step} pages={browserPages} disabled={!!busy}
                      onChange={params => updateSelected(step => ({ ...step, params }))} />
                  ) : selectedAction?.fields.map((field) => (
                    (["browser.mouseClick", "browser.mouseMove", "desktop.mouseClick", "desktop.mouseMove"].includes(selected.step.actionType) && field.key === "y")
                      || (selected.step.actionType === "desktop.keyboardType" && field.key === "typoText" && !selected.step.params.simulateTypo)
                      || (selected.step.actionType === "desktop.keyboardType" && field.key === "delayMs" && selected.step.params.inputMode === "paste")
                      ? null : (
                    <div key={`${selectedId}-${field.key}`} className={field.key === "x" && ["browser.mouseClick", "browser.mouseMove", "desktop.mouseClick", "desktop.mouseMove"].includes(selected.step.actionType) ? "coordinate-input-block" : undefined}>
                      {field.key === "x" && ["browser.mouseClick", "browser.mouseMove"].includes(selected.step.actionType) && <CoordinatePicker
                        key={`${workflowId}:${selectedId}:${pageBrowserId}:${coordinatePage?.pageId}`}
                        api={api} runId={pageBrowserId} pageId={coordinatePage?.pageId} disabledReason={coordinateUnavailable}
                        onBusy={picking => setBusy(picking ? "coordinate-pick" : "")}
                        onPoint={point => setWorkflows(previous => previous.map(item => item.workflowId === workflowId ? {
                          ...item,
                          steps: replaceStep(item.steps, selectedId, step => ({ ...step, params: { ...step.params, x: point.x, y: point.y } })),
                        } : item))}
                      />}
                      {field.key === "x" && ["desktop.mouseClick", "desktop.mouseMove"].includes(selected.step.actionType) && <DesktopCoordinatePicker
                        key={`${workflowId}:${selectedId}`}
                        api={api} disabled={!!busy || workflowRunning}
                        onBusy={picking => setBusy(picking ? "coordinate-pick" : "")}
                        onPoint={point => setWorkflows(previous => previous.map(item => item.workflowId === workflowId ? {
                          ...item,
                          steps: replaceStep(item.steps, selectedId, step => ({ ...step, params: { ...step.params, x: point.x, y: point.y } })),
                        } : item))}
                      />}
                      {field.key === "x" && ["browser.mouseClick", "browser.mouseMove", "desktop.mouseClick", "desktop.mouseMove"].includes(selected.step.actionType) ? (
                        <div className="coordinate-fields" role="group" aria-label="鼠标目标坐标">
                          {(["x", "y"] as const).map(axis => <label key={axis} className="field">
                            <span>{axis === "x" ? "横坐标 X" : "纵坐标 Y"}<span className="required"> *</span></span>
                            <input type="number" value={String(selected.step.params[axis] ?? 0)} disabled={!!busy}
                              onChange={event => setParam(axis, event.target.value === "" ? undefined : Number(event.target.value))} />
                          </label>)}
                        </div>
                      ) : field.key === "selector" && desktopElementSelected && workflow ? (
                        <DesktopTargetField workflow={workflow} step={selected.step} disabled={!!busy} onChange={params => updateSelected(step => ({ ...step, params }))} onElements={() => setInspector("elements")} />
                      ) : field.key === "key" && ["browser.keyPress", "desktop.keyPress"].includes(selected.step.actionType) ? (
                        <KeyPressField value={String(selected.step.params.key ?? "")} disabled={!!busy}
                          inputId={`param-${selectedId}-key`} onChange={value => setParam("key", value)} />
                      ) : field.key === "pageId" && workflow ? (
                        <PageTargetField workflow={workflow} pages={browserPages} value={selected.step.params.pageId === undefined ? undefined : String(selected.step.params.pageId)} stepId={selectedId}
                          inheritedTarget={getInheritedPageTarget(workflow, selectedId)}
                          disabled={!!busy} onChange={value => setParam("pageId", value)} />
                      ) : field.key === "path" && ["file.xlsxRead", "file.xlsxWrite"].includes(selected.step.actionType) ? (
                        <XlsxPathField api={api} mode={selected.step.actionType === "file.xlsxWrite" ? "save" : "open"}
                          value={String(selected.step.params.path ?? "")} disabled={!!busy}
                          onChange={value => setParam("path", value)} />
                      ) : field.key === 'code' && workflow ? (
                        <Suspense fallback={<p>正在读取脚本编辑器…</p>}><ScriptEditor api={api} workflow={workflow} stepId={selectedId} value={String(selected.step.params.code ?? '')} disabled={!!busy} onChange={value => setParam('code', value)}/></Suspense>
                      ) : field.type === "json" ? (
                        <JsonEditor
                          key={parameterEdits[field.key] ?? 0}
                          disabled={!!busy}
                          label={field.label}
                          value={
                            selected.step.params[field.key] === undefined
                              ? (field.defaultValue ?? {})
                              : selected.step.params[field.key]
                          }
                          onChange={(value) => setParam(field.key, value)}
                          onValidity={(valid) =>
                            markValid(`param:${field.key}`, valid)
                          }
                          hint={field.placeholder}
                        />
                      ) : field.type === "boolean" ? (
                        <label className="checkbox-field">
                          <input
                            type="checkbox"
                            checked={Boolean(
                              selected.step.params[field.key] ??
                                field.defaultValue,
                            )}
                            disabled={!!busy}
                            onChange={(event) =>
                              setParam(field.key, event.target.checked)
                            }
                          />
                          <span>{field.label}</span>
                        </label>
                      ) : (
                        <label className="field">
                          <span>
                            {field.label}
                            {field.required && (
                              <span className="required"> *</span>
                            )}
                          </span>
                          {field.type === "select" ? (
                            <select
                              value={String(
                                selected.step.params[field.key] ??
                                  field.defaultValue ??
                                  "",
                              )}
                              disabled={!!busy}
                              onChange={(event) =>
                                setParam(field.key, event.target.value)
                              }
                            >
                              {!field.required && (
                                <option value="">未设置</option>
                              )}
                              {field.options?.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          ) : field.type === "textarea" ? (
                            <textarea
                              id={`param-${selectedId}-${field.key}`}
                              className={
                                /code|script/.test(field.key)
                                  ? "code-input script-input"
                                  : ""
                              }
                              value={String(
                                selected.step.params[field.key] ??
                                  field.defaultValue ??
                                  "",
                              )}
                              disabled={!!busy}
                              placeholder={field.placeholder}
                              spellCheck={false}
                              onChange={(event) =>
                                setParam(field.key, event.target.value)
                              }
                            />
                          ) : (
                            <input
                              id={`param-${selectedId}-${field.key}`}
                              type={field.type === "number" ? "number" : "text"}
                              value={String(
                                selected.step.params[field.key] ??
                                  field.defaultValue ??
                                  "",
                              )}
                              disabled={!!busy}
                              placeholder={field.placeholder}
                              onChange={(event) =>
                                setParam(
                                  field.key,
                                  field.type === "number"
                                    ? event.target.value === ""
                                      ? undefined
                                      : Number(event.target.value)
                                    : event.target.value,
                                )
                              }
                            />
                          )}
                        </label>
                      )}
                      {workflow && ["text", "textarea", "json"].includes(field.type)
                        && !["name", "code", "itemVariable", "pageId"].includes(field.key) && (
                        <VariablePicker
                          workflow={workflow}
                          stepId={selectedId}
                          disabled={!!busy}
                          label={`为${field.label}插入变量`}
                          onPick={reference => {
                            if (field.key === "key") {
                              setParam(field.key, reference);
                              return;
                            }
                            if (field.type === "json") {
                              writeDraftText(`${selectedId}:${inspector}:${field.label}`, undefined);
                              setParam(field.key, reference);
                              // Reset a malformed draft even when the chosen value equals its last valid value.
                              setParameterEdits(previous => ({ ...previous, [field.key]: (previous[field.key] ?? 0) + 1 }));
                              return;
                            }
                            const input = document.getElementById(`param-${selectedId}-${field.key}`) as HTMLInputElement | HTMLTextAreaElement | null;
                            const value = String(selected.step.params[field.key] ?? "");
                            const start = input?.selectionStart ?? value.length;
                            const end = input?.selectionEnd ?? value.length;
                            setParam(field.key, value.slice(0, start) + reference + value.slice(end));
                            requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(start + reference.length, start + reference.length); });
                          }}
                        />
                      )}
                      {selected.step.actionType === "core.log" && field.key === "message" && selectedXlsxLoop && (
                        <small className={/\{\{[^{}]+\}\}\.\d+/.test(String(selected.step.params.message ?? "")) ? "field-error" : ""}>
                          {/\{\{[^{}]+\}\}\.\d+/.test(String(selected.step.params.message ?? "")) && <>下标写成 <code>{`{{${String(selectedXlsxLoop.params.itemVariable || "row")}}}.0`}</code> 时，<code>.0</code> 只是普通文字。<br /></>}
                          {selectedXlsxLoop.params.valueMode === "array"
                            ? <>当前行是数组：<code>{`{{${String(selectedXlsxLoop.params.itemVariable || "row")}}}[0]`}</code> 取第 1 个值，<code>{`{{${String(selectedXlsxLoop.params.itemVariable || "row")}}}[1]`}</code> 取第 2 个值。下标要写在 <code>{"}}"}</code> 后的方括号中。</>
                            : <>当前上层“遍历 XLSX”仍按{selectedXlsxLoop.params.valueMode === "column" ? "单列值" : "整行对象"}运行。要使用 <code>{`{{${String(selectedXlsxLoop.params.itemVariable || "row")}}}[0]`}</code>，请先把上层步骤的“遍历内容”改为“整行数组”。</>}
                        </small>
                      )}
                      {selected.step.actionType === "core.log" && field.key === "message" && selectedXlsxLoop
                        && selectedXlsxLoop.params.valueMode !== "array"
                        && String(selected.step.params.message ?? "").includes(`{{${String(selectedXlsxLoop.params.itemVariable || "row")}}}`) && (
                        <button type="button" className="text-button" disabled={!!busy}
                          onClick={() => {
                            const name = String(selectedXlsxLoop.params.itemVariable || "row");
                            const message = String(selected.step.params.message ?? "");
                            const corrected = message.replace(/\{\{\s*([^{}]+?)\s*\}\}\.(\d+)/g, (original, variable: string, index: string) =>
                              variable.trim() === name ? `{{${name}}}[${index}]` : original);
                            updateWorkflow(value => ({ ...value, steps: replaceStep(
                              replaceStep(value.steps, selectedXlsxLoop.stepId, step => ({ ...step, params: { ...step.params, valueMode: "array" } })),
                              selectedId, step => ({ ...step, params: { ...step.params, message: corrected } }),
                            ) }));
                          }}>
                          切换整行数组并修正下标
                        </button>
                      )}
                    </div>
                  ))) }
                  {!selectedAction && (
                    <JsonEditor
                      disabled={!!busy}
                      label="原始动作参数"
                      value={selected.step.params}
                      objectOnly
                      onValidity={(valid) => markValid("params", valid)}
                      onChange={(value) =>
                        updateSelected((step) => ({
                          ...step,
                          params: value as Record<string, unknown>,
                        }))
                      }
                    />
                  )}
                  {selected.step.actionType !== "core.note" && <label className="field">
                    <span>输出变量</span>
                    <input
                      value={selected.step.output ?? ""}
                      disabled={!!busy}
                      placeholder="例如：exportFile"
                      onChange={(event) =>
                        updateSelected((step) => ({
                          ...step,
                          output: event.target.value || undefined,
                        }))
                      }
                    />
                    <small>将动作结果写入变量；后续指令可点「插入变量」选择，或填写 {"{{变量名}}"}。</small>
                  </label>}

                </>
              ) : (
                <div className="panel-empty">
                  <MousePointer2 size={26} />
                  <h3>选择一个步骤</h3>
                  <p>在中央列表中选择步骤，编辑动作参数和失败策略。</p>
                </div>
              ))}
            {inspector !== "step" && selected?.step.actionType === "core.note" && <div className="panel-empty">
              <StickyNote size={26} /><h3>备注仅用于说明</h3><p>在“步骤参数”中编辑文字和底色。备注不执行操作，无需配置超时、重试、变量或网页元素。</p>
            </div>}
            {inspector === "settings" && selected && selected.step.actionType !== "core.note" && (<>                  <div className="step-settings">
                    <h2 className="panel-title">指令设置</h2><p className="help-text">仅应用于当前选中的指令。</p>
                    <label className="field">
                      <span>{selected.step.actionType === "core.wait" ? "步骤超时（秒）" : "步骤超时（毫秒）"}</span>
                      <input
                        type="number"
                        min={selected.step.actionType === "core.wait" ? 0.1 : 100}
                        max={selected.step.actionType === "core.wait" ? 3600 : 3600000}
                        step={selected.step.actionType === "core.wait" ? 0.001 : 1}
                        value={selected.step.actionType === "core.wait" ? selected.step.timeoutMs === undefined ? "" : selected.step.timeoutMs / 1000 : selected.step.timeoutMs ?? 30000}
                        placeholder={selected.step.actionType === "core.wait" ? "自动：等待时长 + 1 秒" : undefined}
                        disabled={!!busy}
                        onChange={(event) =>
                          updateSelected((step) => ({
                            ...step,
                            timeoutMs: step.actionType === "core.wait" ? event.target.value === "" ? undefined : Math.round(Number(event.target.value) * 1000) : Number(event.target.value),
                          }))
                        }
                      />
                      {selected.step.actionType === "core.wait" && <small>留空按等待时长自动设置超时；填写数字可覆盖。容器中的等待仍受容器总超时限制。</small>}
                    </label>
                    <label className="field">
                      <span>失败后</span>
                      <select
                        value={selected.step.onError ?? "fail"}
                        disabled={!!busy}
                        onChange={(event) =>
                          updateSelected((step) => ({
                            ...step,
                            onError: event.target.value as StepDefinition['onError'],
                          }))
                        }
                      >
                        <option value="fail">结束运行并记录错误</option>
                        <option value="continue">忽略失败，继续执行</option>
                        <option value="manual">等待人工选择重做、确认或跳过</option>
                        <option
                          value="pause"
                          disabled={!selectedAction?.safeToRetry}
                        >
                          暂停，等待人工恢复（读取 / 校验）
                        </option>
                      </select>
                    </label>
                    {['control.forEach', 'control.forEachXlsx'].includes(selected.step.actionType) && <label className="field"><span>续跑业务键模板</span><input aria-label="续跑业务键模板" value={String(selected.step.params.progressKey ?? '')} placeholder="例如 {{item.orderId}} 或 {{row}}[0]" disabled={!!busy} onChange={event => setParam('progressKey', event.target.value || undefined)}/><small>每项必须产生唯一非空文本或数字；完成后记录进度，重启检查后可续跑。</small></label>}
                    <JsonEditor label="恢复前检查（JSON步骤数组）" value={selected.step.recoveryChecks ?? []} disabled={!!busy} onValidity={valid => markValid('recovery-checks', valid)} onChange={value => updateSelected(step => ({ ...step, recoveryChecks: value as StepDefinition[] }))} hint="仅允许读取或校验动作；配置检查步骤和输出变量后，可在等待人工时执行。"/>
                    <label className="field">
                      <span>最多尝试次数</span>
                      <input
                        type="number"
                        min={1}
                        max={5}
                        value={selected.step.retry?.maxAttempts ?? 1}
                        disabled={!!busy || !selectedAction?.safeToRetry}
                        onChange={(event) =>
                          updateSelected((step) => ({
                            ...step,
                            retry: {
                              maxAttempts: Number(event.target.value),
                              delayMs: step.retry?.delayMs ?? 1000,
                            },
                          }))
                        }
                      />
                      <small>
                        {selectedAction?.safeToRetry
                          ? "包含首次执行；仅为支持安全重试的动作启用。"
                          : "此动作可能产生外部效果，不启用自动重试。"}
                      </small>
                    </label>
                    {(selected.step.retry?.maxAttempts ?? 1) > 1 && (
                      <label className="field">
                        <span>{selected.step.actionType === "core.wait" ? "重试间隔（秒）" : "重试间隔（毫秒）"}</span>
                        <input
                          type="number"
                          min={0}
                          max={selected.step.actionType === "core.wait" ? 60 : undefined}
                          step={selected.step.actionType === "core.wait" ? 0.001 : 1}
                          value={selected.step.actionType === "core.wait" ? (selected.step.retry?.delayMs ?? 1000) / 1000 : selected.step.retry?.delayMs ?? 1000}
                          disabled={!!busy}
                          onChange={(event) =>
                            updateSelected((step) => ({
                              ...step,
                              retry: {
                                maxAttempts: step.retry?.maxAttempts ?? 1,
                                delayMs: step.actionType === "core.wait" ? Math.round(Number(event.target.value) * 1000) : Number(event.target.value),
                              },
                            }))
                          }
                        />
                      </label>
                    )}
                  </div><label className="field"><span>指令下载目录</span><input value={selected.step.settings?.downloadDir ?? ""} placeholder={workflow?.settings.downloadDir} disabled={!!busy} onChange={event => updateSelected(step => ({ ...step, settings: { ...step.settings, downloadDir: event.target.value || undefined } }))} /><small>留空继承容器或流程默认目录。</small></label><label className="field"><span>指令 Python 可执行文件</span><input value={selected.step.settings?.pythonExecutable ?? ""} placeholder={workflow?.settings.pythonExecutable ?? "python"} disabled={!!busy} onChange={event => updateSelected(step => ({ ...step, settings: { ...step.settings, pythonExecutable: event.target.value || undefined } }))} /><small>仅影响本指令及其子步骤。</small></label></>)}
            {inspector !== "step" && !selected && <div className="panel-empty"><MousePointer2 size={26} /><h3>先选择一个步骤</h3><p>每条指令拥有独立设置、变量和元素。</p></div>}
            {inspector === "inputs" && selected && selected.step.actionType !== "core.note" && (
              <>
                <h2 className="panel-title">指令变量</h2>
                <p className="help-text">
                  仅在本指令及子步骤内生效，优先于流程默认值；输出变量可传递给后续步骤。
                </p>
                <JsonEditor
                  disabled={!!busy}
                  key={selectedId + "-variables"}
                  label="变量 JSON"
                  value={selected.step.variables ?? {}}
                  objectOnly
                  onValidity={(valid) => markValid("variables", valid)}
                  onChange={(value) =>
                    updateSelected((item) => ({
                      ...item,
                      variables: value as WorkflowDefinition["variables"],
                    }))
                  }
                  hint={"使用 {{变量名}} 在动作参数中引用变量。"}
                />
              </>
            )}
            {inspector === "elements" && selected && selected.step.actionType !== "core.note" && (
              <>
                {workflow && <DesktopElements key={`${workflowId}:${selectedId}`} api={api} workflow={workflow} step={selected.step} disabled={!!busy || workflowRunning} onBusy={working => setBusy(working ? "desktop-element" : "")} onChange={next => updateWorkflow(() => next)} />}
                {workflow && <Suspense fallback={<p>正在读取网页元素工具…</p>}><WebElements key={`web:${workflowId}:${selectedId}`} api={api} workflow={workflow} step={selected.step} runId={pageBrowserId} pageId={coordinatePage?.pageId ?? '$current'} disabled={!!busy || workflowRunning} onBusy={working => setBusy(working ? 'web-element' : '')} onChange={next => updateWorkflow(() => next)}/></Suspense>}
                <h2 className="panel-title">元素引用</h2>
                <p className="help-text">
                  当前指令通过 @元素名 引用自己的元素；子步骤继承，其他指令不受影响。
                </p>
                <JsonEditor
                  disabled={!!busy}
                  key={selectedId + "-elements"}
                  label="元素库 JSON"
                  value={selected.step.elements ?? {}}
                  objectOnly
                  onValidity={(valid) => markValid("elements", valid)}
                  onChange={(value) =>
                    updateSelected((item) => ({
                      ...item,
                      elements: value as WorkflowDefinition["elements"],
                    }))
                  }
                />
              </>
            )}
            {invalid && (
              <p className="field-error" role="alert">
                请修正参数错误后保存或运行。
              </p>
            )}
          </div>
          </div>
          <section className="console" id="run-monitor-panel" aria-label="运行监控" hidden={rightPane !== "run"}>
            <div className="console-header">
              <div className="run-tabs" role="tablist" aria-label="运行信息">
                {tabs.map((tab, index) => (
                  <button
                    key={tab.id}
                    id={`tab-${tab.id}`}
                    role="tab"
                    aria-label={tab.label}
                    title={tab.label}
                    aria-selected={runTab === tab.id}
                    aria-controls={`panel-${tab.id}`}
                    tabIndex={runTab === tab.id ? 0 : -1}
                    className={runTab === tab.id ? "active" : ""}
                    onClick={() => setRunTab(tab.id)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                        event.preventDefault();
                        const next =
                          tabs[
                            (index +
                              (event.key === "ArrowRight" ? 1 : -1) +
                              tabs.length) %
                              tabs.length
                          ]!;
                        setRunTab(next.id);
                        document.getElementById(`tab-${next.id}`)?.focus();
                      }
                    }}
                  >
                    {tab.icon}
                    {tab.shortLabel}
                    {!!tab.count && <span className="count">{tab.count}</span>}
                  </button>
                ))}
              </div>
            </div>
              <div className="run-tools">
                <div className="run-selection">
                <select aria-label="运行查看范围" className="run-scope" value={runScope} onChange={event => {
                  setRunScope(event.target.value as "workflow" | "all");
                  if (event.target.value === "all" && !runId) setRunId(runs[0]?.runId ?? "");
                }}><option value="workflow">当前流程</option><option value="all">全部流程</option></select>
                <select
                  aria-label="当前查看的运行"
                  value={runId}
                  onChange={(event) => setRunId(event.target.value)}
                >
                  <option value="">选择运行记录</option>
                  {scopedRuns.map((item) => (
                    <option key={item.runId} value={item.runId}>
                      {formatTime(item.startedAt)} · {item.workflowName}{item.stepId ? " · 单条" : ""}
                    </option>
                  ))}
                </select>
                </div>
                <IconButton
                  label={
                    run?.status === "paused" || run?.status === "waiting_manual"
                      ? "继续所选运行"
                      : "暂停所选运行（当前步骤完成后）"
                  }
                  disabled={!activeRun || !!busy || run?.status === "queued"}
                  onClick={() =>
                    void control(
                      run?.status === "paused" || run?.status === "waiting_manual"
                        ? "resume"
                        : "pause",
                    )
                  }
                >
                  {run?.status === "paused" || run?.status === "waiting_manual" ? (
                    <Play size={16} />
                  ) : (
                    <Pause size={16} />
                  )}
                </IconButton>
                <IconButton
                  label="停止所选运行"
                  disabled={!activeRun || !!busy}
                  danger
                  onClick={() => void control("stop")}
                >
                  <Square size={15} />
                </IconButton>
                <IconButton
                  label="显示所选运行浏览器"
                  disabled={!browserAvailable || !!busy}
                  onClick={() => void control("show")}
                >
                  <Eye size={16} />
                </IconButton>
                <IconButton
                  label="最小化所选运行浏览器"
                  disabled={!browserAvailable || !!busy}
                  onClick={() => void control("hide")}
                >
                  <EyeOff size={16} />
                </IconButton>
                <IconButton
                  label={activeRun ? "关闭浏览器前请先停止所选运行" : "关闭所选运行浏览器"}
                  disabled={!retainedBrowser || !!busy}
                  danger
                  onClick={() => void control("closeBrowser")}
                >
                  <X size={16} />
                </IconButton>
              </div>
            <div className="run-context" aria-label="所选运行上下文">
              {run ? <><strong title={run.workflowName}>{run.workflowName}</strong><code>{run.runId.slice(0, 8)}</code><span>v{run.revision}{run.stepId ? " · 单条运行" : ""}</span><Status status={run.status} />{retainedBrowser && <RetainedBrowserStatus />}
                {run.workflowId !== workflowId && <span className="run-other-flow">正在查看其他流程</span>}</>
                : <span>{runScope === "workflow" ? `「${workflow?.name ?? "当前流程"}」尚无运行记录` : "选择一条运行记录查看执行情况"}</span>}
            </div>
            {run?.waitingReason && <p className="resource-wait" role="status">{run.waitingReason}</p>}
            {run?.debug && run.status === 'paused' && <div className="run-debug-actions"><button disabled={!!busy} onClick={() => void control('step')}>执行下一步</button><button disabled={!!busy} onClick={() => void control('resume')}>继续调试</button></div>}
            {run?.status === 'waiting_manual' && <details className="manual-decisions"><summary>人工恢复决策</summary><div><button disabled={!!busy} onClick={() => void control('check')}>执行恢复检查</button><button disabled={!!busy} onClick={() => { if (confirm('已确认本步骤的业务结果完成？该操作不会自动生成缺失的输出变量。')) void control('confirm'); }}>确认已完成并继续</button><button disabled={!!busy} onClick={() => { if (confirm('明确重新执行可能产生外部效果的步骤？请先检查已有结果。')) void control('retry'); }}>明确重新执行</button><button disabled={!!busy} onClick={() => { if (confirm('跳过该步骤并记录警告？该业务项仍需核对。')) void control('skip'); }}>跳过并记录警告</button></div></details>}
            {run && terminalStatuses.has(run.status) && <details className="attempt-tools"><summary>执行尝试与数据续跑 · {attempts.length} 次</summary><button disabled={!!busy} onClick={() => { if (!confirm('使用原修订和原输入重建会话？未知业务项需要检查后决定，未配置业务键的流程无法续跑。')) return; setBusy('recover'); void api?.recoverRun(run.runId).then(snapshot => { setRunId(snapshot.runId); setRuns(previous => [snapshot, ...previous]); showRunPanel(); }).catch(catchError).finally(() => setBusy('')); }}>检查后建立数据续跑</button><AttemptRecords attempts={attempts}/></details>}
            {!!run?.warningCount && <WarningRecords key={`${runId}:${run.attemptId}`} warnings={run.warnings ?? []} status={run.status} onSelect={locateRunStep}/>}
            {recovery && run && <div className="run-recovery" role="region" aria-label="运行恢复">
              <div className="run-recovery-copy"><strong>{recovery.canResume ? "需要人工处理" : run.status === "interrupted" ? "运行已中断" : "运行失败"}{recovery.stepId ? ` · ${stepNames.get(recovery.stepId) ?? recovery.stepId}` : ""}</strong>
                <p title={run.error ?? recovery.reason}>{recovery.reason}</p>
                <small>{run.manualDecisionRequired ? "指令可能部分完成，请先检查现场，再展开人工恢复决策。" : recovery.canResume ? "处理后继续会重试失败指令，使用本次运行参数；修改草稿须停止后重跑。" : "修改草稿后重新运行将从头开始；单条运行只执行该指令。"}</small>
              </div>
              <div className="run-recovery-actions">
                {recovery.stepId && <button disabled={!!busy} onClick={() => locateRunStep(recovery.stepId!)}>定位失败步骤</button>}
                {run.browserOpen && runWorkflow && !runWorkflow.settings.headless && <button disabled={!!busy} onClick={() => void control("show")}><Eye size={14} />显示浏览器</button>}
                {recovery.canResume ? <button className="primary" disabled={!!busy || !!run.manualDecisionRequired} onClick={() => void control("resume")}><Play size={14} />{run.manualDecisionRequired ? "请选择恢复决策" : "处理后继续"}</button>
                  : <button disabled={!!busy || !workflows.some(flow => flow.workflowId === run.workflowId)} onClick={() => openWorkflow(run.workflowId)}>编辑后重新运行</button>}
              </div>
            </div>}
            <div
              className={`console-content${runTab === "logs" ? " console-content-logs" : ""}`}
              role="tabpanel"
              id={`panel-${runTab}`}
              aria-labelledby={`tab-${runTab}`}
              tabIndex={0}
            >
              {runTab === "logs" && <LogViewer
                events={events}
                runId={runId}
                attempts={attempts.map(attempt=>({attemptId:attempt.attemptId,label:`${new Date(attempt.run.startedAt).toLocaleString('zh-CN')} · ${attempt.attemptId.slice(0,8)}`}))}
                stepNames={stepNames}
                emptyMessage={run?.error ?? (run ? "该运行暂无实时日志。历史运行的状态、变量与产物可在对应面板查看。" : "运行流程后，在这里查看步骤进度和执行日志。")}
                onSelectStep={locateRunStep}
                onOpenPath={path => void api?.openPath(path).catch(catchError)}
              />}
              {runTab === "variables" &&
                (run && Object.keys(run.variables).length ? (
                  <ValueViewer variables={run.variables}/>
                ) : (
                  <div className="console-empty"><Braces size={23} /><span>所选运行尚未产生变量。</span></div>
                ))}
              {runTab === "artifacts" &&
                (run?.artifacts.length ? (
                  <ul className="runtime-files">
                    {run.artifacts.map((artifact: Artifact) => (
                      <li key={artifact.path}>
                        <div className="runtime-file-heading"><FileText size={16} /><strong>{artifact.name}</strong><span>{artifact.size < 1024 ? `${artifact.size} B` : `${(artifact.size / 1024).toFixed(1)} KB`}</span></div>
                        <code className="artifact-path" title={artifact.path}>{artifact.path}</code>
                        <button className="text-button" onClick={() => void api?.openPath(artifact.path).catch(catchError)}><FolderOpen size={14} />打开</button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="console-empty"><Download size={23} /><span>下载成功后，文件路径和大小将在这里显示。</span></div>
                ))}
              {runTab === "runs" && api && <Suspense fallback={<p>正在读取历史…</p>}><RunHistory api={api} workflows={workflows} onError={catchError} onSelect={item => { setRunScope("all");setRunId(item.runId);setRunTab("logs");setRuns(previous => previous.some(run=>run.runId===item.runId) ? previous : [item,...previous]); }}/></Suspense>}
            </div>
          </section>
        </aside>
      </div>
      <footer className="statusbar">
        <span>
          <span className={`connection-dot${api ? " connected" : ""}`} />
          {loading
            ? "正在连接运行服务"
            : api
              ? "本地运行服务"
              : "桌面服务未连接"}
        </span>
        <span>
          {runs.filter((item) => !terminalStatuses.has(item.status)).length}{" "}
          个活跃任务
          {retainedBrowserCount > 0 && (
            <>
              <span className="footer-divider">·</span>
              {retainedBrowserCount} 个浏览器保留中（占用资源）
            </>
          )}
          <span className="footer-divider">·</span>JSON 流程 v1
          <span className="footer-divider">·</span>并发上限 {maxConcurrent}
        </span>
      </footer>
    </div>
    </DraftContext.Provider>
  );
}
