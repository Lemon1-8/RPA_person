import { useEffect, useId, useRef, useState } from "react";
import { Crosshair, Loader2, X } from "lucide-react";
import type { BrowserPoint, DesktopApi } from "../../../../packages/contracts/src/index.js";

export function CoordinatePicker({ api, runId, pageId, disabledReason, onPoint, onBusy }: {
  api?: DesktopApi;
  runId?: string;
  pageId?: string;
  disabledReason?: string;
  onPoint(point: BrowserPoint): void;
  onBusy(busy: boolean): void;
}) {
  const hintId = useId();
  const [picking, setPicking] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const active = useRef<string | null>(null);
  const callbacks = useRef({ onPoint, onBusy });
  callbacks.current = { onPoint, onBusy };
  useEffect(() => () => {
    const id = active.current;
    active.current = null;
    if (id && api && runId) {
      void api.cancelBrowserPoint(runId, id).catch(() => undefined);
      callbacks.current.onBusy(false);
    }
  }, [api, runId, pageId]);

  async function start() {
    if (!api || !runId || !pageId || disabledReason || active.current) return;
    const id = crypto.randomUUID();
    active.current = id;
    setPicking(true); setMessage(""); setFailed(false); callbacks.current.onBusy(true);
    try {
      const point = await api.pickBrowserPoint(runId, pageId, id);
      if (active.current !== id) return;
      if (point) {
        callbacks.current.onPoint(point);
        setMessage(`已填入 X: ${point.x}，Y: ${point.y}`);
      } else setMessage("取点已取消或超时，原坐标保留。");
    } catch (error) {
      if (active.current === id) { setFailed(true); setMessage(error instanceof Error ? error.message : String(error)); }
    } finally {
      if (active.current === id) { active.current = null; setPicking(false); callbacks.current.onBusy(false); }
    }
  }
  async function cancel() {
    const id = active.current;
    if (!id || !api || !runId) return;
    try { await api.cancelBrowserPoint(runId, id); }
    catch (error) { setFailed(true); setMessage(error instanceof Error ? error.message : String(error)); }
  }
  return <div className="coordinate-picker-field">
    <div className="coordinate-picker-actions">
      <button type="button" onClick={() => void start()} disabled={picking || !!disabledReason} aria-describedby={hintId}>
        {picking ? <Loader2 size={15} className="spin" /> : <Crosshair size={15} />}
        {picking ? "等待选取坐标" : "获取坐标"}
      </button>
      {picking && <button type="button" onClick={() => void cancel()}><X size={15} />取消取点</button>}
    </div>
    <small id={hintId}>{picking ? "已进入浏览器取点模式。按住 Ctrl + Alt 并单击选定位置，Esc 取消。" : disabledReason || "在目标网页按住 Ctrl + Alt 并单击，自动填入下方 X、Y。"}</small>
    {message && <small role={failed ? "alert" : "status"} className={failed ? "field-error" : "coordinate-picker-result"}>{message}</small>}
  </div>;
}
