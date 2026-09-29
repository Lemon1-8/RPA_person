import { useEffect, useRef, useState } from "react";
import { shortcutFromKeydown } from "./key-shortcut.js";

const commonKeys = [
  "Enter", "Tab", "Escape", "Backspace", "Delete", "Space",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Control+A", "Control+C", "Control+V", "F1", "F2", "F5", "F8",
];

export function KeyPressField({ value, disabled, inputId, onChange }: {
  value: string;
  disabled: boolean;
  inputId: string;
  onChange(value: string): void;
}) {
  const [custom, setCustom] = useState(!commonKeys.includes(value));
  const [recording, setRecording] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!commonKeys.includes(value)) setCustom(true);
    setRecording(false);
  }, [value]);

  const startRecording = () => {
    setCustom(true);
    setRecording(true);
    requestAnimationFrame(() => input.current?.focus());
  };

  return <div className="field key-press-field">
    <span id={`${inputId}-label`}>按键或快捷键 <span className="required">*</span></span>
    <select aria-labelledby={`${inputId}-label`} value={custom ? "custom" : value} disabled={disabled}
      onChange={event => {
        if (event.target.value === "custom") {
          startRecording();
        } else {
          setCustom(false);
          setRecording(false);
          onChange(event.target.value);
        }
      }}>
      {commonKeys.map(key => <option key={key} value={key}>{key}</option>)}
      <option value="custom">自定义输入…</option>
    </select>
    {custom && <>
      <input ref={input} id={inputId} aria-label="自定义按键或变量" value={value} disabled={disabled}
        readOnly={recording} placeholder="如 Control+S 或 {{shortcut}}"
        onChange={event => onChange(event.target.value)}
        onBlur={() => setRecording(false)}
        onKeyDown={event => {
          if (!recording) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.repeat) return;
          const shortcut = shortcutFromKeydown(event.nativeEvent);
          if (!shortcut) return;
          setRecording(false);
          onChange(shortcut);
          event.currentTarget.blur();
        }} />
      <div className="key-press-tools">
        <small aria-live="polite">{recording ? "请按下要录制的按键或组合键" : "可直接修改快捷键，或插入变量"}</small>
        <button type="button" disabled={disabled} onClick={() => {
          if (recording) {
            setRecording(false);
            requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
          } else startRecording();
        }}>{recording ? "手动输入" : "重新录制"}</button>
      </div>
    </>}
    {!custom && <small>选择常用按键；选“自定义输入”可按键盘录制快捷键。</small>}
  </div>;
}
