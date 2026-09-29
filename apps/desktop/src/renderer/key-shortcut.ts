type ShortcutKeyEvent = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

const codeKeys: Record<string, string> = {
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
};

/** Convert one completed keydown into the shortcut syntax accepted by both runners. */
export function shortcutFromKeydown(event: ShortcutKeyEvent): string | undefined {
  if (["Control", "Alt", "Shift", "Meta", "AltGraph", "Process", "Dead", "Unidentified"].includes(event.key)) return undefined;

  let key = event.key;
  if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
  else if (/^Digit[0-9]$/.test(event.code)) key = event.code.slice(5);
  else if (codeKeys[event.code]) key = codeKeys[event.code];
  else if (key === " ") key = "Space";
  else if (key === "Esc") key = "Escape";
  else if (key.length === 1) key = key.toUpperCase();

  // The runners use '+' as a separator, so a literal plus key cannot be represented.
  if (key === "+" || !(/^[A-Z0-9]$/.test(key) || /^[`\-=\[\]\\;',.\/]$/.test(key)
    || ["Enter", "Tab", "Escape", "Backspace", "Delete", "Insert", "Space", "Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)
    || /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key))) return undefined;

  return [event.ctrlKey && "Control", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Meta", key]
    .filter(Boolean).join("+");
}
