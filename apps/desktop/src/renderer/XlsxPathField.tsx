import { useId, useState } from "react";
import { FolderOpen } from "lucide-react";
import type { DesktopApi } from "../../../../packages/contracts/src/index.js";

export function XlsxPathField({ api, mode, value, disabled, onChange, hint, required = true }: {
  api?: DesktopApi;
  mode: "open" | "save";
  value: string;
  disabled: boolean;
  onChange: (path: string) => void;
  hint?: string;
  required?: boolean;
}) {
  const inputId = useId();
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState("");
  const buttonLabel = mode === "save" ? "选择 XLSX 保存位置" : "选择 XLSX 文件";

  async function choose() {
    if (!api || disabled || choosing) return;
    setChoosing(true);
    setError("");
    try {
      const path = await api.chooseXlsxPath(mode, value);
      if (path) onChange(path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChoosing(false);
    }
  }

  return <div className="field xlsx-path-field">
    <label htmlFor={inputId}>文件路径{required && <span className="required"> *</span>}</label>
    <div className="input-with-button">
      <input id={inputId} aria-label="文件路径" title={value} value={value} disabled={disabled || choosing}
        placeholder="C:\\RPA\\orders.xlsx" onChange={event => { setError(""); onChange(event.target.value); }} />
      <button type="button" className="xlsx-browse-button" aria-label={buttonLabel} title={buttonLabel}
        disabled={disabled || choosing || !api} onClick={() => void choose()}>
        <FolderOpen size={15} aria-hidden="true" />{choosing ? "选择中" : mode === "save" ? "另存为…" : "浏览…"}
      </button>
    </div>
    <small>{hint ?? (mode === "save" ? "选择保存位置和文件名，也可填写包含变量的完整路径。" : "从文件资源管理器选择 .xlsx 文件，也可填写包含变量的完整路径。")}</small>
    {error && <small className="field-error" role="alert">{error}</small>}
  </div>;
}
