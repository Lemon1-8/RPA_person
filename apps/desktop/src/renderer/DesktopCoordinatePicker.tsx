import { useEffect, useId, useRef, useState } from "react";
import { Crosshair, Loader2, X } from "lucide-react";
import type { DesktopApi, DesktopPoint } from "../../../../packages/contracts/src/index.js";

export function DesktopCoordinatePicker({ api, disabled, onPoint, onBusy }: {
  api?: DesktopApi;
  disabled: boolean;
  onPoint(point: DesktopPoint): void;
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
    if (id && api) {
      void api.cancelDesktopPoint(id).catch(() => undefined);
      callbacks.current.onBusy(false);
    }
  }, [api]);

  async function start() {
    if (!api || disabled || active.current) return;
    const id = crypto.randomUUID();
    active.current = id;
    setPicking(true); setMessage(""); setFailed(false); callbacks.current.onBusy(true);
    try {
      const point = await api.pickDesktopPoint(id);
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

  return <div className="coordinate-picker-field">
    <div className="coordinate-picker-actions">
      <button type="button" onClick={() => void start()} disabled={disabled || picking || !api} aria-describedby={hintId}>
        {picking ? <Loader2 size={15} className="spin" /> : <Crosshair size={15} />}
        {picking ? "等待选取坐标" : "获取屏幕坐标"}
      </button>
      {picking && <button type="button" onClick={() => void api?.cancelDesktopPoint(active.current!).catch(error => { setFailed(true); setMessage(String(error)); })}><X size={15} />取消取点</button>}
    </div>
    <small id={hintId}>{picking ? "将鼠标移到目标位置，按 F8 取点；30 秒后自动取消。" : "点击后将鼠标移到目标软件或网页，按 F8 自动填入屏幕坐标。"}</small>
    {message && <small role={failed ? "alert" : "status"} className={failed ? "field-error" : "coordinate-picker-result"}>{message}</small>}
  </div>;
}
