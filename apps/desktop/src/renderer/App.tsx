import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  PanelBottomClose,
  PanelBottomOpen,
  Play,
  Plus,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  StickyNote,
  Terminal,
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
import { SchedulesPage } from "./SchedulesPage.js";
import { StepTree } from "./StepTree.js";
import { ControlFlowFields, getControlStepErrors } from "./ControlFlowFields.js";
import { NoteFields, getNoteStepErrors } from "./NoteFields.js";
import { VariablePicker } from "./VariablePicker.js";
import { BrowserCloseFields, BrowserOpenFields, PageTargetField } from "./BrowserFields.js";
import { CoordinatePicker } from "./CoordinatePicker.js";
import { DesktopCoordinatePicker } from "./DesktopCoordinatePicker.js";
import { KeyPressField } from "./KeyPressField.js";
import { XlsxPathField } from "./XlsxPathField.js";
import { LogViewer } from "./LogViewer.js";
import { getBrowserPageErrors, getInheritedPageTarget } from "./page-options.js";

const api = (window as Window & { rpa?: DesktopApi }).rpa;
const terminalStatuses = new Set([
  "succeeded",
  "failed",
  "stopped",
  "interrupted",
]);
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
type BottomTab = "logs" | "variables" | "artifacts" | "runs";

function clampConsoleHeight(height: number): number {
  const minimum = window.innerWidth <= 740 ? 160 : 112;
  return Math.min(Math.max(height, minimum), Math.max(minimum, window.innerHeight - 360));
}
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

function IconButton({
  label,
  children,
  disabled,
  onClick,
  danger,
}: {
  label: string;
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-button${danger ? " danger" : ""}`}
      title={label}
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
  const [draft, setDraft] = useState(serialized);
  const [error, setError] = useState("");
  const ownValue = useRef(serialized);
  useEffect(() => {
    if (ownValue.current !== serialized) {
      setDraft(serialized);
      ownValue.current = serialized;
    }
    setError("");
    onValidity(true);
  }, [serialized]);
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
    try { return { left: true, right: true, bottom: true, ...JSON.parse(localStorage.getItem("rpa.panels") ?? "{}") } as { left: boolean; right: boolean; bottom: boolean }; }
    catch { return { left: true, right: true, bottom: true }; }
  });
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [workflowId, setWorkflowId] = useState("");
  const [actions, setActions] = useState<ActionDefinition[]>([]);
  const [runs, setRuns] = useState<RunSnapshot[]>([]);
  const [runId, setRunId] = useState("");
  const [stepBrowserTargets, setStepBrowserTargets] = useState<Record<string, string>>({});
  const [pageInventory, setPageInventory] = useState<{ runId: string; pages: BrowserPageInfo[]; error?: string }>({ runId: "", pages: [] });
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [inspector, setInspector] = useState<InspectorTab>("step");
  const [bottomTab, setBottomTab] = useState<BottomTab>("logs");
  const [consoleHeight, setConsoleHeight] = useState<number | null>(() => {
    const saved = localStorage.getItem("rpa.consoleHeight");
    return saved !== null && Number.isFinite(Number(saved)) ? clampConsoleHeight(Number(saved)) : null;
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dataDir, setDataDir] = useState("");
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
  const consoleRef = useRef<HTMLElement>(null);
  const consoleResize = useRef<{ pointerId: number; y: number; height: number } | null>(null);
  useEffect(() => {
    if (consoleHeight !== null) localStorage.setItem("rpa.consoleHeight", String(consoleHeight));
  }, [consoleHeight]);
  useEffect(() => {
    const onResize = () => setConsoleHeight(height => height === null ? null : clampConsoleHeight(height));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const workflow = workflows.find((item) => item.workflowId === workflowId);
  const steps = useMemo(
    () => flatten(workflow?.steps ?? []),
    [workflow?.steps],
  );
  const stepNames = useMemo(() => new Map(steps.map(item => [item.step.stepId, item.step.name])), [steps]);
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
  const desktopInputSelected = !!selected?.step.actionType.startsWith("desktop.");
  const availableActions = useMemo(() => actions.filter(action => ![
    "browser.start",
    "browser.switchPage",
    "core.assert",
    "browser.assertText",
    "browser.table",
    "browser.text",
    "browser.response",
    "browser.select",
  ].includes(action.type)), [actions]);
  const run = runs.find((item) => item.runId === runId);
  const dirty = !!workflow && saved[workflowId] !== JSON.stringify(workflow);
  const validationScope = `${workflowId}:${selectedId}:${inspector}:${view}:`;
  const invalid = !(inspector === "step" && selectedCommented) && Object.entries(invalidFields).some(([key, value]) => key.startsWith(validationScope) && value);
  const workflowErrors = useMemo(() => workflow ? [...getBrowserPageErrors(workflow), ...getControlStepErrors(workflow), ...getNoteStepErrors(workflow)] : [], [workflow]);
  const invalidWorkflow = invalid || workflowErrors.length > 0;
  const activeRun = run && !terminalStatuses.has(run.status);
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
      `${item.label} ${item.type} ${item.description}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )) {
      const group = groups.get(action.category) ?? [];
      group.push(action);
      groups.set(action.category, group);
    }
    return [...groups.entries()];
  }, [availableActions, query]);

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
    let mounted = true;
    const off = api.onEvent((event) => {
      if (!mounted) return;
      setEvents((previous) => [...previous.slice(-3999), event]);
      if (event.run) {
        const snapshot = event.run;
        setRuns((previous) => [
          snapshot,
          ...previous.filter((item) => item.runId !== snapshot.runId),
        ]);
      }
    });
    api
      .bootstrap()
      .then((state) => {
        if (!mounted) return;
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
        setRunId(state.runs[0]?.runId ?? "");
        setSaved(
          Object.fromEntries(
            state.workflows.map((item) => [
              item.workflowId,
              JSON.stringify(item),
            ]),
          ),
        );
        setDataDir(state.dataDir);
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
      off();
    };
  }, []);

  useEffect(() => {
    localStorage.setItem("rpa.panels", JSON.stringify(panels));
  }, [panels]);
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
    update: (value: WorkflowDefinition) => WorkflowDefinition,
  ) => {
    if (busy) return;
    setWorkflows((previous) =>
      previous.map((item) =>
        item.workflowId === workflowId ? update(item) : item,
      ),
    );
  };
  const updateSelected = (update: (step: StepDefinition) => StepDefinition) =>
    updateWorkflow((value) => ({
      ...value,
      steps: replaceStep(value.steps, selectedId, update),
    }));
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
    });
  const catchError = (cause: unknown) =>
    setError(cause instanceof Error ? cause.message : String(cause));

  async function saveWorkflow(thenRun = false) {
    if (!api || !workflow || busy || invalidWorkflow) return;
    setBusy(thenRun ? "run" : "save");
    setError("");
    try {
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
      if (thenRun) {
        const snapshot = await api.runWorkflow(persisted);
        setRuns((previous) =>
          previous.some((item) => item.runId === snapshot.runId)
            ? previous
            : [snapshot, ...previous],
        );
        setRunId(snapshot.runId);
        setBottomTab("logs");
        setPanels(previous => ({ ...previous, bottom: true }));
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
      const snapshot = await api.runStep(workflow, stepId, targetBrowser?.runId);
      // Events may arrive before this IPC response; do not replace their newer state.
      setRuns((previous) => previous.some((item) => item.runId === snapshot.runId)
        ? previous : [snapshot, ...previous]);
      setRunId(snapshot.runId);
      if (stepBrowserTarget === "new") setStepBrowserTargets((previous) => ({ ...previous, [workflowId]: "auto" }));
      setSelectedId(stepId);
      setBottomTab("logs");
      setPanels((previous) => ({ ...previous, bottom: true }));
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
      ...(action.type === "core.note" ? {} : { onError: "fail" as const }),
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
    setInspector("step");
    setPanels(previous => ({ ...previous, right: true }));
  }

  function mutateStep(id: string, command: "up" | "down" | "copy" | "delete") {
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
    setOpenFlows(previous => [...previous, created.workflowId]);
    setSelectedId("");
    setView("settings");
  }

  function openWorkflow(id: string, destination: typeof view = "editor") {
    const next = workflows.find(item => item.workflowId === id);
    if (!next) return;
    setWorkflowId(id);
    setSelectedId(next.steps[0]?.stepId ?? "");
    setOpenFlows(previous => previous.includes(id) ? previous : [...previous, id]);
    setView(destination);
    setInspector("step");
  }

  function duplicateWorkflow(source: WorkflowDefinition) {
    const copied = { ...clone(source), workflowId: uuid(), name: `${source.name} 副本`, revision: 0, steps: source.steps.map(copyStep) };
    delete copied.settings.profileId;
    setWorkflows(previous => [...previous, copied]);
    setWorkflowId(copied.workflowId); setSelectedId(copied.steps[0]?.stepId ?? "");
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
    id: BottomTab;
    label: string;
    icon: ReactNode;
    count?: number;
  }[] = [
    { id: "logs", label: "运行日志", icon: <Terminal size={15} /> },
    { id: "variables", label: "变量", icon: <Braces size={15} /> },
    {
      id: "artifacts",
      label: "下载产物",
      icon: <Download size={15} />,
      count: run?.artifacts.length,
    },
    {
      id: "runs",
      label: "全部运行",
      icon: <Layers size={15} />,
      count: runs.length,
    },
  ];

  return (
    <div className="app-shell">
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
            title="控制下方选中的运行；当前步骤完成后暂停"
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
            {run?.status === "paused" || run?.status === "waiting_manual"
              ? "继续"
              : "暂停"}
          </button>
          <button
            className="top-run-control"
            title="停止下方选中的运行"
            disabled={!activeRun || !!busy}
            onClick={() => void control("stop")}
          >
            <Square size={14} />
            停止
          </button>
        </div>
      </header>

      {error && (
        <div className="alert" role="alert">
          <AlertCircle size={17} />
          <span>{error}</span>
          <IconButton label="关闭提示" onClick={() => setError("")}>
            <X size={16} />
          </IconButton>
        </div>
      )}
      {workflowErrors[0] && ["editor", "settings"].includes(view) && <div className="alert page-validation" role="status">
        <AlertCircle size={17} />
        <span>“{workflowErrors[0].stepName}”：{workflowErrors[0].error}{workflowErrors.length > 1 ? `（另有 ${workflowErrors.length - 1} 项待完善）` : ""}</span>
        <button className="text-button" onClick={() => {
          setSelectedId(workflowErrors[0].stepId); setInspector("step"); setView("editor"); setPanels(previous => ({ ...previous, right: true }));
        }}>定位步骤</button>
      </div>}
      {notice && (
        <div className="toast" role="status">
          <Check size={16} />
          {notice}
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
          <button aria-label={panels.bottom ? "收起底部栏" : "展开底部栏"} title={panels.bottom ? "收起底部栏" : "展开底部栏"} aria-expanded={panels.bottom} onClick={() => setPanels(value => ({ ...value, bottom: !value.bottom }))}>{panels.bottom ? <PanelBottomClose size={17} /> : <PanelBottomOpen size={17} />}</button>
        </div>
      </nav>
      {view === "workflows" && <WorkflowsPage workflows={workflows} saved={saved} busy={loading || !!busy || !api} onCreate={createWorkflow} onOpen={openWorkflow} onSettings={id => openWorkflow(id, "settings")} onCopy={duplicateWorkflow} onDelete={deleteWorkflow} />}
      {view === "schedules" && api && <SchedulesPage api={api} workflows={workflows} runs={runs} initial={schedules} onError={catchError} />}
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
                {demoUrl && (
                  <div className="environment-info">
                    <span>受控演示页</span>
                    <code>{demoUrl}</code>
                    <small>
                      示例用于验证自动化闭环，不代表真实站点已适配。
                    </small>
                  </div>
                )}
              <details className="advanced"><summary>流程默认变量与元素（供所有指令继承）</summary><p className="help-text">每条指令可在右侧配置自己的覆盖值。此处保留已有流程的默认配置。</p><JsonEditor label="流程默认变量 JSON" value={workflow.variables} objectOnly disabled={!!busy} onValidity={valid => markValid("workflow-variables", valid)} onChange={value => updateWorkflow(item => ({ ...item, variables: value as WorkflowDefinition["variables"] }))} /><JsonEditor label="流程默认元素 JSON" value={workflow.elements} objectOnly disabled={!!busy} onValidity={valid => markValid("workflow-elements", valid)} onChange={value => updateWorkflow(item => ({ ...item, elements: value as WorkflowDefinition["elements"] }))} /></details></div></main>
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
          <div className="action-groups">
            {loading ? (
              <div className="skeleton-list" aria-label="加载指令库">
                {[1, 2, 3, 4, 5].map((item) => (
                  <div key={item} />
                ))}
              </div>
            ) : actionGroups.length ? (
              actionGroups.map(([category, items]) => (
                <section key={category} className="action-group">
                  <h3>{category}</h3>
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
                </section>
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
            <button
              className="text-button"
              disabled={!workflow}
              onClick={() => setView("settings")}
            >
              <Settings2 size={15} />
              运行设置
            </button>
          </div>
          {workflow && (selected?.step.actionType === "core.note" ? <div className="single-step-toolbar" aria-label="备注说明">
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
          <div className="editor-caption">
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
                  onSelect={id => { setSelectedId(id); setInspector("step"); setPanels(previous => ({ ...previous, right: true })); }}
                  onRun={id => void runSingleStep(id)}
                  onToggleComment={toggleComments}
                  onMutate={mutateStep}
                  onAdd={addAction}
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
                    ? "从左侧指令库选择一个动作，开始编排流程。"
                    : "请从 Electron 桌面应用启动，以加载流程和运行服务。"}
                </p>
                {workflow && (
                  <button onClick={() => searchRef.current?.focus()}>
                    <Plus size={16} />
                    选择指令
                  </button>
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
          <div className="inspector-body" key={`${workflowId}:${selectedId}:${view}`}>
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
                            onError: event.target.value as "fail" | "pause" | "continue",
                          }))
                        }
                      >
                        <option value="fail">结束运行并记录错误</option>
                        <option value="continue">忽略失败，继续执行</option>
                        <option
                          value="pause"
                          disabled={!selectedAction?.safeToRetry}
                        >
                          暂停，等待人工恢复（读取 / 校验）
                        </option>
                      </select>
                    </label>
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
        </aside>
      </div>

      <section ref={consoleRef} className="console" aria-label="运行监控"
        style={consoleHeight === null ? undefined : { height: clampConsoleHeight(consoleHeight) }}
        hidden={!panels.bottom || (view !== "editor" && view !== "settings")}>
        <div className="console-resizer" role="separator" aria-label="调整运行监控高度"
          aria-orientation="horizontal" aria-valuemin={window.innerWidth <= 740 ? 160 : 112}
          aria-valuemax={Math.max(window.innerWidth <= 740 ? 160 : 112, window.innerHeight - 360)}
          aria-valuenow={Math.round(consoleHeight ?? consoleRef.current?.getBoundingClientRect().height
            ?? clampConsoleHeight(window.innerWidth <= 740 ? 310 : Math.min(280, Math.max(140, window.innerHeight * 0.23))))}
          tabIndex={0} title="拖动调整底部面板高度；方向键也可调整"
          onPointerDown={event => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            consoleResize.current = { pointerId: event.pointerId, y: event.clientY, height: consoleRef.current?.getBoundingClientRect().height ?? 0 };
          }}
          onPointerMove={event => {
            const start = consoleResize.current;
            if (start?.pointerId === event.pointerId) setConsoleHeight(clampConsoleHeight(start.height + start.y - event.clientY));
          }}
          onPointerUp={event => {
            if (consoleResize.current?.pointerId === event.pointerId) consoleResize.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => { consoleResize.current = null; }}
          onKeyDown={event => {
            const current = consoleRef.current?.getBoundingClientRect().height ?? 200;
            const next = event.key === "ArrowUp" ? current + 24 : event.key === "ArrowDown" ? current - 24
              : event.key === "Home" ? 0 : event.key === "End" ? window.innerHeight : null;
            if (next !== null) { event.preventDefault(); setConsoleHeight(clampConsoleHeight(next)); }
          }} />
        <div className="console-header">
          <div className="bottom-tabs" role="tablist" aria-label="运行信息">
            {tabs.map((tab, index) => (
              <button
                key={tab.id}
                id={`tab-${tab.id}`}
                role="tab"
                aria-selected={bottomTab === tab.id}
                aria-controls={`panel-${tab.id}`}
                tabIndex={bottomTab === tab.id ? 0 : -1}
                className={bottomTab === tab.id ? "active" : ""}
                onClick={() => setBottomTab(tab.id)}
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
                    setBottomTab(next.id);
                    document.getElementById(`tab-${next.id}`)?.focus();
                  }
                }}
              >
                {tab.icon}
                {tab.label}
                {!!tab.count && <span className="count">{tab.count}</span>}
              </button>
            ))}
          </div>
          <div className="run-tools">
            {run && (
              <>
                <Status status={run.status} />
                {retainedBrowser && <RetainedBrowserStatus />}
                <span className="run-version">v{run.revision}</span>
              </>
            )}
            <select
              aria-label="当前查看的运行"
              value={runId}
              onChange={(event) => setRunId(event.target.value)}
            >
              <option value="">选择运行记录</option>
              {runs.map((item) => (
                <option key={item.runId} value={item.runId}>
                  {formatTime(item.startedAt)} · {item.workflowName}{item.stepId ? " · 单条" : ""}
                </option>
              ))}
            </select>
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
        </div>
        <div
          className={`console-content${bottomTab === "logs" ? " console-content-logs" : ""}`}
          role="tabpanel"
          id={`panel-${bottomTab}`}
          aria-labelledby={`tab-${bottomTab}`}
          tabIndex={0}
        >
          {bottomTab === "logs" && <LogViewer
            events={events}
            runId={runId}
            stepNames={stepNames}
            emptyMessage={run?.error ?? (run ? "该运行暂无实时日志。历史运行的状态、变量与产物可在对应面板查看。" : "运行流程后，在这里查看步骤进度和执行日志。")}
            onSelectStep={stepId => { setSelectedId(stepId); setInspector("step"); }}
            onOpenPath={path => void api?.openPath(path).catch(catchError)}
          />}
          {bottomTab === "variables" &&
            (run && Object.keys(run.variables).length ? (
              <table>
                <thead>
                  <tr>
                    <th>变量名称</th>
                    <th>类型</th>
                    <th>当前值</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(run.variables).map(([name, value]) => (
                    <tr key={name}>
                      <td>
                        <code>{name}</code>
                      </td>
                      <td className="muted">
                        {value === null
                          ? "null"
                          : Array.isArray(value)
                            ? "array"
                            : typeof value}
                      </td>
                      <td>
                        <code className="variable-value">{toText(value)}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="console-empty">
                <Braces size={23} />
                <span>所选运行尚未产生变量。</span>
              </div>
            ))}
          {bottomTab === "artifacts" &&
            (run?.artifacts.length ? (
              <table>
                <thead>
                  <tr>
                    <th>文件名称</th>
                    <th>保存路径</th>
                    <th className="number-cell">大小</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {run.artifacts.map((artifact: Artifact) => (
                    <tr key={artifact.path}>
                      <td>
                        <span className="file-name">
                          <FileText size={16} />
                          {artifact.name}
                        </span>
                      </td>
                      <td>
                        <code className="artifact-path" title={artifact.path}>
                          {artifact.path}
                        </code>
                      </td>
                      <td className="number-cell">
                        {artifact.size < 1024
                          ? `${artifact.size} B`
                          : `${(artifact.size / 1024).toFixed(1)} KB`}
                      </td>
                      <td>
                        <button
                          className="text-button"
                          onClick={() =>
                            void api?.openPath(artifact.path).catch(catchError)
                          }
                        >
                          <FolderOpen size={14} />
                          打开
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="console-empty">
                <Download size={23} />
                <span>下载成功后，文件路径和大小将在这里显示。</span>
              </div>
            ))}
          {bottomTab === "runs" &&
            (runs.length ? (
              <table>
                <thead>
                  <tr>
                    <th>流程 / 运行 ID</th>
                    <th>版本</th>
                    <th>开始时间</th>
                    <th>状态</th>
                    <th>当前步骤 / 错误</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((item) => (
                    <tr
                      key={item.runId}
                      className={runId === item.runId ? "selected-row" : ""}
                    >
                      <td>
                        <button
                          className="run-select"
                          onClick={() => {
                            setRunId(item.runId);
                            setBottomTab("logs");
                          }}
                        >
                          <strong>{item.workflowName}{item.stepId ? " · 单条运行" : ""}</strong>
                          <code>{item.runId.slice(0, 12)}</code>
                        </button>
                      </td>
                      <td>v{item.revision}</td>
                      <td>
                        {new Date(item.startedAt).toLocaleString("zh-CN", {
                          hour12: false,
                        })}
                      </td>
                      <td>
                        <Status status={item.status} />
                        {item.browserOpen && terminalStatuses.has(item.status) && (
                          <RetainedBrowserStatus />
                        )}
                      </td>
                      <td className={item.error ? "error-text" : "muted"}>
                        {item.error ?? item.currentStepId ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="console-empty">
                <Layers size={23} />
                <span>还没有运行记录。保存流程后，点击顶部「运行」。</span>
              </div>
            ))}
        </div>
      </section>
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
        </span>
      </footer>
    </div>
  );
}
