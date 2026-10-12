import { spawn } from 'node:child_process';
import { withDesktopInteraction } from '../../windows/src/interaction-lock.js';
import type { InputPolicy } from '../../windows/src/interaction-lock.js';
import { inputGuardMembers } from '../../windows/src/input-guard.js';
import { randomUUID } from 'node:crypto';

const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;

public static class RpaDesktopInput {
${inputGuardMembers}
  [StructLayout(LayoutKind.Sequential)] struct KeyInput {
    public ushort vk, scan;
    public uint flags, time;
    public IntPtr extra;
  }
  [StructLayout(LayoutKind.Sequential)] struct MouseInput {
    public int x, y;
    public uint data, flags, time;
    public IntPtr extra;
  }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion {
    [FieldOffset(0)] public KeyInput key;
    [FieldOffset(0)] public MouseInput mouse;
  }
  [StructLayout(LayoutKind.Sequential)] struct Input {
    public uint type;
    public InputUnion data;
  }
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);
  [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
  [DllImport("user32.dll", SetLastError = true)] static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flag);
  [DllImport("user32.dll", SetLastError = true)] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] inputs, int size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern short VkKeyScanW(char character);

  static IntPtr expectedWindow;
  public static void Guard(long handle) { expectedWindow = new IntPtr(handle); EnsureTarget(); }
  static void EnsureTarget() {
    CheckOwnership();
    if (expectedWindow != IntPtr.Zero && GetForegroundWindow() != expectedWindow)
      throw new InvalidOperationException("UNAVAILABLE: 目标窗口已失去前台焦点，已停止模拟操作");
  }

  static void Cursor(int x, int y) {
    EnsureTarget();
    Input[] inputs = new Input[1]; inputs[0].type=0;
    ownedX=x; ownedY=y;
    inputs[0].data.mouse.x=(int)Math.Round((x-GetSystemMetrics(76))*65535.0/Math.Max(1,GetSystemMetrics(78)-1));
    inputs[0].data.mouse.y=(int)Math.Round((y-GetSystemMetrics(77))*65535.0/Math.Max(1,GetSystemMetrics(79)-1));
    inputs[0].data.mouse.flags=0xC001;
    inputs[0].data.mouse.extra=new IntPtr((long)ownerMarker.ToUInt64());
    if(SendInput(1,inputs,Marshal.SizeOf(typeof(Input)))!=1) throw new Win32Exception(Marshal.GetLastWin32Error(), "无法移动鼠标，请检查桌面会话");
  }
  static void Mouse(uint flags, int value = 0) {
    EnsureTarget();
    if ((flags & 0x02)!=0) heldMouse |= 0x04; if ((flags & 0x08)!=0) heldMouse |= 0x10; if ((flags & 0x20)!=0) heldMouse |= 0x40;
    Input[] inputs = new Input[1];
    inputs[0].type = 0;
    inputs[0].data.mouse.data = unchecked((uint)value);
    inputs[0].data.mouse.flags = flags;
    inputs[0].data.mouse.extra = new IntPtr((long)ownerMarker.ToUInt64());
    if (SendInput(1, inputs, Marshal.SizeOf(typeof(Input))) != 1)
      throw new Win32Exception(Marshal.GetLastWin32Error(), "鼠标操作失败，请检查桌面会话权限");
    heldMouse &= ~flags;
  }
  public static void Probe() { }
  public static void Move(int x, int y, bool humanLike) {
    if (!humanLike) { Cursor(x, y); return; }
    Point start;
    if (!GetCursorPos(out start)) throw new Win32Exception(Marshal.GetLastWin32Error(), "无法读取鼠标位置");
    double dx = x - start.x, dy = y - start.y;
    double distance = Math.Sqrt(dx * dx + dy * dy);
    if (distance < 2) { Cursor(x, y); return; }
    Random random = new Random();
    int duration = Math.Min(1000, Math.Max(220, (int)(distance * 0.9) + random.Next(90, 180)));
    int frames = Math.Max(16, duration / 14);
    double curve = distance < 50 ? distance * 0.08 : Math.Min(150, Math.Max(35, distance * (0.18 + random.NextDouble() * 0.12)));
    curve *= random.Next(2) == 0 ? -1 : 1;
    double nx = -dy / distance, ny = dx / distance;
    double c1x = start.x + dx * 0.24 + nx * curve * 0.8;
    double c1y = start.y + dy * 0.24 + ny * curve * 0.8;
    double c2x = start.x + dx * 0.78 + nx * curve * 1.15;
    double c2y = start.y + dy * 0.78 + ny * curve * 1.15;
    for (int frame = 1; frame <= frames; frame++) {
      double t = (double)frame / frames;
      double eased = t * t * (3 - 2 * t);
      double inverse = 1 - eased;
      Cursor((int)Math.Round(inverse * inverse * inverse * start.x + 3 * inverse * inverse * eased * c1x + 3 * inverse * eased * eased * c2x + eased * eased * eased * x),
        (int)Math.Round(inverse * inverse * inverse * start.y + 3 * inverse * inverse * eased * c1y + 3 * inverse * eased * eased * c2y + eased * eased * eased * y));
      if (frame < frames) Pause(duration / frames);
    }
  }
  public static void Click(int x, int y, string button, int count, bool humanLike) {
    Move(x, y, humanLike);
    if (humanLike) Pause(70);
    EnsureTarget();
    if (expectedWindow != IntPtr.Zero && GetAncestor(WindowFromPoint(new Point { x=x, y=y }),2) != expectedWindow)
      throw new InvalidOperationException("UNAVAILABLE: 点击位置已被遮挡或目标窗口已移动");
    uint down = button == "right" ? 0x0008u : button == "middle" ? 0x0020u : 0x0002u;
    uint up = button == "right" ? 0x0010u : button == "middle" ? 0x0040u : 0x0004u;
    for (int i = 0; i < count; i++) {
      Mouse(down);
      if(expectedWindow==IntPtr.Zero) { initialForeground=GetAncestor(WindowFromPoint(new Point { x=x, y=y }),2); if(cancelEvent.WaitOne(30)) throw new InvalidOperationException("INPUT_CANCELLED: 电脑输入已取消"); }
      Mouse(up);
      if (i + 1 < count) Pause(80);
    }
  }
  public static void Wheel(int dx, int dy) {
    if (dy != 0) Mouse(0x0800u, dy);
    if (dx != 0) Mouse(0x1000u, dx);
  }
  static void KeyDown(byte key) { EnsureTarget(); heldKeys.Add(key); keybd_event(key, 0, 0, ownerMarker); }
  static void KeyUp(byte key) { keybd_event(key, 0, 2, ownerMarker); heldKeys.Remove(key); }
  static byte KeyCode(string value, out bool shift) {
    shift = false;
    if (value.Length == 1) {
      short mapped = VkKeyScanW(value[0]);
      if (mapped == -1) throw new ArgumentException("不支持的按键：" + value);
      shift = ((mapped >> 8) & 1) != 0;
      return (byte)(mapped & 0xff);
    }
    switch (value.ToLowerInvariant()) {
      case "enter": case "return": return 0x0d;
      case "tab": return 0x09;
      case "escape": case "esc": return 0x1b;
      case "backspace": return 0x08;
      case "delete": case "del": return 0x2e;
      case "insert": return 0x2d;
      case "space": return 0x20;
      case "home": return 0x24;
      case "end": return 0x23;
      case "pageup": return 0x21;
      case "pagedown": return 0x22;
      case "arrowleft": case "left": return 0x25;
      case "arrowup": case "up": return 0x26;
      case "arrowright": case "right": return 0x27;
      case "arrowdown": case "down": return 0x28;
    }
    int number;
    if (value.Length > 1 && (value[0] == 'F' || value[0] == 'f') && int.TryParse(value.Substring(1), out number) && number >= 1 && number <= 24)
      return (byte)(0x6f + number);
    throw new ArgumentException("不支持的按键：" + value);
  }
  public static void Press(string combination) {
    EnsureTarget();
    string[] parts = combination.Split(new char[] { '+' }, StringSplitOptions.RemoveEmptyEntries);
    if (parts.Length == 0) throw new ArgumentException("按键不能为空");
    bool shift, ctrl = false, alt = false, win = false;
    byte key = KeyCode(parts[parts.Length - 1].Trim(), out shift);
    shift = parts.Length == 1 && shift;
    for (int i = 0; i + 1 < parts.Length; i++) {
      switch (parts[i].Trim().ToLowerInvariant()) {
        case "control": case "ctrl": case "controlormeta": ctrl = true; break;
        case "shift": shift = true; break;
        case "alt": alt = true; break;
        case "meta": case "win": case "windows": win = true; break;
        default: throw new ArgumentException("不支持的修饰键：" + parts[i]);
      }
    }
    byte[] modifiers = new byte[] { (byte)(ctrl ? 0x11 : 0), (byte)(alt ? 0x12 : 0), (byte)(shift ? 0x10 : 0), (byte)(win ? 0x5b : 0) };
    try {
      foreach (byte modifier in modifiers) if (modifier != 0) KeyDown(modifier);
      KeyDown(key); KeyUp(key);
    } finally {
      for (int i = modifiers.Length - 1; i >= 0; i--) if (modifiers[i] != 0) KeyUp(modifiers[i]);
    }
  }
  public static void Type(string text, int delayMs) {
    foreach (char character in text) {
      EnsureTarget();
      Input[] inputs = new Input[2];
      inputs[0].type = 1;
      inputs[0].data.key.scan = character;
      inputs[0].data.key.flags = 0x0004u;
      inputs[0].data.key.extra = new IntPtr((long)ownerMarker.ToUInt64());
      inputs[1].type = 1;
      inputs[1].data.key.scan = character;
      inputs[1].data.key.flags = 0x0006u;
      inputs[1].data.key.extra = new IntPtr((long)ownerMarker.ToUInt64());
      if (SendInput(2, inputs, Marshal.SizeOf(typeof(Input))) != 2)
        throw new Win32Exception(Marshal.GetLastWin32Error(), "键盘输入失败，请检查前台窗口权限或锁屏状态");
      if (delayMs > 0) Pause(delayMs);
    }
  }
  public static void Backspace(int count) {
    for (int i = 0; i < count; i++) { Press("Backspace"); Pause(45); }
  }
  public static void Paste(string text) {
    Press("Control+V");
    Pause(120);
  }
}
'@
  $p = $payload.params
  [RpaDesktopInput]::BeginOwnership([string]$payload.cancelEvent)
  if ($null -ne $p.expectedWindow) { [RpaDesktopInput]::Guard([long]$p.expectedWindow) }
  switch ($payload.action) {
    'probe' { [RpaDesktopInput]::Probe() }
    'desktop.mouseClick' { [RpaDesktopInput]::Click([int]$p.x, [int]$p.y, [string]$p.button, [int]$p.clickCount, ($p.humanLike -ne $false)) }
    'desktop.mouseMove' { [RpaDesktopInput]::Move([int]$p.x, [int]$p.y, ($p.humanLike -ne $false)) }
    'desktop.mouseWheel' { [RpaDesktopInput]::Wheel([int]$p.deltaX, [int]$p.deltaY) }
    'desktop.keyPress' { [RpaDesktopInput]::Press([string]$p.key) }
    'desktop.elementFill' {
      [RpaDesktopInput]::Click([int]$p.x, [int]$p.y, 'left', 1, $true)
      Start-Sleep -Milliseconds 120
      if ($p.append) { [RpaDesktopInput]::Press('Control+End') } else { [RpaDesktopInput]::Press('Control+A') }
      Start-Sleep -Milliseconds 120
      if (!$p.append) { [RpaDesktopInput]::Press('Backspace'); Start-Sleep -Milliseconds 120 }
      [RpaDesktopInput]::Type([string]$p.text, 0)
    }
    'desktop.keyboardType' {
      if ($p.simulateTypo -eq $true) {
        $wrong = if ([string]$p.typoText -ne '') { [string]$p.typoText } else { '错' }
        [RpaDesktopInput]::Type($wrong, [int]$p.delayMs)
        Start-Sleep -Milliseconds 180
        [RpaDesktopInput]::Backspace($wrong.Length)
        Start-Sleep -Milliseconds 120
      }
      if ($p.inputMode -eq 'paste') {
        if ([string]$p.text -ne '') {
          Add-Type -AssemblyName System.Windows.Forms
          $originalClipboard = New-Object System.Windows.Forms.DataObject
          $originalData = [System.Windows.Forms.Clipboard]::GetDataObject()
          if ($null -ne $originalData) { foreach ($format in $originalData.GetFormats($false)) { $originalClipboard.SetData($format, $false, $originalData.GetData($format, $false)) } }
          Set-Clipboard -Value ([string]$p.text)
          $ownedClipboardSequence = [RpaDesktopInput]::GetClipboardSequenceNumber()
          [RpaDesktopInput]::Paste([string]$p.text)
        }
      }
      else { [RpaDesktopInput]::Type([string]$p.text, [int]$p.delayMs) }
    }
    default { throw "不支持的电脑键鼠指令：$($payload.action)" }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  if ($null -ne $originalClipboard -and [RpaDesktopInput]::GetClipboardSequenceNumber() -eq $ownedClipboardSequence) { try { [System.Windows.Forms.Clipboard]::SetDataObject($originalClipboard, $true) } catch {} }
  if ('RpaDesktopInput' -as [type]) { [RpaDesktopInput]::EndOwnership() }
}
`;

/** Send input to the foreground Windows desktop, never through a browser session. */
export function runDesktopInput(action: string, params: Record<string, unknown>, timeoutMs = 30_000, signal?: AbortSignal, policy?: InputPolicy): Promise<{ ok: true }> {
  if (action === 'probe') return runDesktopInputUnlocked(action, params, timeoutMs, signal);
  if (action === 'desktop.keyPress' && typeof params.key === 'string') {
    const parts = params.key.split('+').filter(Boolean).map(value => value.trim()); const last = parts.at(-1) ?? '';
    const keys = new Set(['enter','return','tab','escape','esc','backspace','delete','del','insert','space','home','end','pageup','pagedown','arrowleft','left','arrowup','up','arrowright','right','arrowdown','down']);
    if (last.length !== 1 && !keys.has(last.toLowerCase()) && !/^F(?:[1-9]|1\d|2[0-4])$/i.test(last)) return Promise.reject(new Error(`不支持的按键：${last}`));
    if (parts.slice(0, -1).some(value => !['control','ctrl','controlormeta','shift','alt','meta','win','windows'].includes(value.toLowerCase()))) return Promise.reject(new Error('不支持的修饰键'));
  }
  return withDesktopInteraction(timeoutMs, signal, remaining => runDesktopInputUnlocked(action, params, remaining, signal), policy ?? { idleMs: 3000, waitMs: 900000 });
}

/** Caller must own the desktop interaction lock while activating and sending input. */
export function runDesktopInputUnlocked(action: string, params: Record<string, unknown>, timeoutMs = 30_000, signal?: AbortSignal): Promise<{ ok: true }> {
  if (process.platform !== 'win32') return Promise.reject(new Error('电脑键鼠操作仅支持 Windows'));
  if (signal?.aborted) return Promise.reject(new Error('电脑键鼠操作已取消'));
  return new Promise((resolve, reject) => {
    const loader = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false); [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); Invoke-Expression ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String([Console]::In.ReadLine())))";
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(loader, 'utf16le').toString('base64')], {
      windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'],
    });
    let error = '';
    const cancelEvent = `Local\\RpaInputCancel${randomUUID().replaceAll('-', '')}`;
    let cancellation: Error | undefined; let killTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (cause?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (cause) reject(cause); else resolve({ ok: true });
    };
    const cancel = (cause: Error) => {
      if (cancellation) return; cancellation = cause;
      const source = `$e=[System.Threading.EventWaitHandle]::OpenExisting('${cancelEvent}'); [void]$e.Set(); $e.Dispose()`;
      const helper = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' }); helper.on('error', () => {});
      killTimer = setTimeout(() => { child.kill(); }, 1500);
    };
    const abort = () => cancel(new Error('电脑键鼠操作已取消'));
    const timer = setTimeout(() => cancel(new Error(`电脑键鼠操作超时（${timeoutMs} ms）`)), timeoutMs);
    child.stderr.on('data', data => { if (error.length < 4000) error += String(data); });
    child.stdin.on('error', cause => { if (!settled) { child.kill(); finish(cause); } });
    child.on('error', cause => finish(cause));
    child.on('exit', code => finish(cancellation ?? (code === 0 ? undefined : new Error(error.trim() || `电脑键鼠操作失败（退出码 ${code}）`))));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else child.stdin.end(`${Buffer.from(script, 'utf16le').toString('base64')}\n${JSON.stringify({ action, params, cancelEvent })}`);
  });
}
