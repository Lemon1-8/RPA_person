import { spawn } from 'node:child_process';

/** Observe every Windows foreground change, including brief activation at startup. */
export async function observeForeground() {
  const source = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RpaForegroundObserver {
  public delegate void Callback(IntPtr hook, uint evt, IntPtr hwnd, int obj, int child, uint thread, uint time);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, Callback callback, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  static Callback callback = OnEvent;
  public static IntPtr hook;
  static void OnEvent(IntPtr h, uint e, IntPtr hwnd, int obj, int child, uint thread, uint time) { Emit(hwnd); }
  static void Emit(IntPtr hwnd) { uint pid; GetWindowThreadProcessId(hwnd, out pid); Console.WriteLine(hwnd.ToInt64() + "," + pid); }
  public static void Start() {
    hook = SetWinEventHook(3, 3, IntPtr.Zero, callback, 0, 0, 0);
    if (hook == IntPtr.Zero) throw new Exception("Unable to observe foreground events");
    Emit(GetForegroundWindow()); Console.WriteLine("READY");
  }
}
'@
[RpaForegroundObserver]::Start()
while ($true) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 10 }
`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', source], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let phase = 'baseline';
  const events: Array<{ hwnd: string; pid: number; phase: string }> = [];
  const stop = () => { child.kill(); child.stdout.destroy(); child.stderr.destroy(); };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Foreground observer timed out')), 10_000);
      let buffer = '';
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stderr.on('data', data => { clearTimeout(timer); reject(new Error(String(data))); });
      child.stdout.on('data', data => {
        buffer += data.toString();
        const lines = buffer.split(/\r?\n/); buffer = lines.pop()!;
        for (const line of lines) {
          if (line === 'READY') { clearTimeout(timer); resolve(); }
          const match = /^(\d+),(\d+)$/.exec(line);
          if (match) events.push({ hwnd: match[1], pid: Number(match[2]), phase });
        }
      });
    });
    return { events, stop, phase: (value: string) => { phase = value; } };
  } catch (error) { stop(); throw error; }
}
