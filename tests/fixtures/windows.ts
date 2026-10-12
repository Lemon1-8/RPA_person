import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { DesktopElementRef } from '../../packages/contracts/src/index.js';

const script = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Threading;
using System.Runtime.InteropServices;
public static class RpaFixtureReader {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
  public static ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();
  public static void Start() {
    Thread thread = new Thread(() => { string line; while ((line = Console.In.ReadLine()) != null) Lines.Enqueue(line); Lines.Enqueue("__EOF__"); });
    thread.IsBackground = true; thread.Start();
  }
}
'@
[System.Windows.Forms.Application]::EnableVisualStyles()
$form=New-Object System.Windows.Forms.Form
$form.Text='RPA-Windows-TEST_TITLE'
$form.Name='rpaFixture'; $form.Width=580; $form.Height=440
$form.TopMost=$true
$form.StartPosition='Manual'; $form.Left=120; $form.Top=100
$inputBox=New-Object System.Windows.Forms.TextBox
$inputBox.Name='input'; $inputBox.AccessibleName='输入'; $inputBox.Text='初始'; $inputBox.Left=25; $inputBox.Top=25; $inputBox.Width=320
$button=New-Object System.Windows.Forms.Button
$button.Name='button'; $button.AccessibleName='提交'; $button.Text='提交'; $button.Left=25; $button.Top=65
$label=New-Object System.Windows.Forms.Label
$label.Name='result'; $label.AccessibleName='结果'; $label.Text='0'; $label.Left=150; $label.Top=70
$button.Add_Click({ $label.Text=([int]$label.Text+1).ToString() })
$check=New-Object System.Windows.Forms.CheckBox
$check.Name='check'; $check.AccessibleName='同意'; $check.Text='同意'; $check.Left=25; $check.Top=110
$combo=New-Object System.Windows.Forms.ComboBox
$combo.Name='combo'; $combo.AccessibleName='城市'; $combo.Left=25; $combo.Top=155; $combo.Width=200
$combo.DropDownStyle='DropDownList'; [void]$combo.Items.Add('杭州'); [void]$combo.Items.Add('上海'); $combo.SelectedIndex=0
$disabled=New-Object System.Windows.Forms.Button
$disabled.AccessibleName='禁用'; $disabled.Text='禁用'; $disabled.Enabled=$false; $disabled.Left=25; $disabled.Top=210
$form.Controls.AddRange(@($inputBox,$button,$label,$check,$combo,$disabled))
foreach ($x in @(25,160)) { $duplicate=New-Object System.Windows.Forms.Button; $duplicate.Name='duplicate'; $duplicate.AccessibleName='重复'; $duplicate.Text='重复'; $duplicate.Left=$x; $duplicate.Top=260; $form.Controls.Add($duplicate) }
[void]$form.AccessibilityObject
foreach ($control in $form.Controls) { [void]$control.AccessibilityObject }
[RpaFixtureReader]::Start()
$timer=New-Object System.Windows.Forms.Timer
$timer.Interval=50
$timer.Add_Tick({
  $line=$null
  if (![RpaFixtureReader]::Lines.TryDequeue([ref]$line)) { return }
  if ($line -eq '__EOF__') { $form.Close(); return }
  $request=$line | ConvertFrom-Json
  switch ($request.method) {
    'move' { $form.Left=250; $form.Top=180 }
    'recreate' { $form.Controls.Remove($inputBox); $inputBox.Dispose(); $script:inputBox=New-Object System.Windows.Forms.TextBox; $inputBox.Name='input'; $inputBox.AccessibleName='输入'; $inputBox.Text='重建'; $inputBox.Left=25; $inputBox.Top=25; $inputBox.Width=320; $form.Controls.Add($inputBox) }
    'activate' { $form.Activate(); $form.BringToFront() }
    'close' { $form.Close() }
  }
  $point=$inputBox.PointToScreen((New-Object System.Drawing.Point(10,10)))
  [Console]::Out.WriteLine((@{id=$request.id;text=$inputBox.Text;clicks=[int]$label.Text;checked=$check.Checked;selected=$combo.Text;x=$point.X;y=$point.Y} | ConvertTo-Json -Compress))
})
$form.Add_Shown({ [void][RpaFixtureReader]::ShowWindow($form.Handle,5); $form.Activate(); $timer.Start(); $point=$inputBox.PointToScreen((New-Object System.Drawing.Point(10,10))); [Console]::Out.WriteLine((@{ready=$true;pid=$PID;x=$point.X;y=$point.Y} | ConvertTo-Json -Compress)) })
[System.Windows.Forms.Application]::Run($form)
$timer.Dispose();$form.Dispose()
`;

export interface WindowsFixture {
  title: string; pid: number; x: number; y: number; child: ChildProcessWithoutNullStreams;
  element(name: string): DesktopElementRef;
  call(method: string): Promise<{ text: string; clicks: number; checked: boolean; selected: string; x: number; y: number }>;
  close(): Promise<void>;
}
/** Probe the current position without moving the cursor or sending keys. */
export async function desktopInteractionAvailable(): Promise<boolean> {
  if (process.env.RPA_SKIP_DESKTOP_INTERACTION === '1') return false;
  const probe = String.raw`
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class RpaInteractionProbe {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x,y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
}
'@
$point=New-Object RpaInteractionProbe+Point
$available=[RpaInteractionProbe]::GetCursorPos([ref]$point) -and [RpaInteractionProbe]::SetCursorPos($point.x,$point.y)
[Console]::WriteLine($available.ToString())
`;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(probe, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15_000 });
  return stdout.trim() === 'True';
}
export async function startWindowsFixture(): Promise<WindowsFixture> {
  const title = randomUUID();
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script.replace('TEST_TITLE', title), 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let error = ''; let sequence = 0;
  child.stderr.on('data', chunk => { error = (error + String(chunk)).slice(-3000); });
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise<{ pid: number; x: number; y: number }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Windows fixture startup timeout: ' + error)); }, 15_000);
    lines.on('line', line => { try { const value = JSON.parse(line); if (value.ready) { clearTimeout(timer); resolve(value); } else { pending.get(value.id)?.resolve(value); pending.delete(value.id); } } catch { reject(new Error(line)); } });
    child.once('error', cause => { clearTimeout(timer); reject(cause); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Windows fixture exited: ' + error)); for (const item of pending.values()) item.reject(new Error('Fixture closed')); pending.clear(); });
  });
  const info = await ready;
  return {
    ...info, child, title: 'RPA-Windows-' + title,
    element: name => ({ backend: 'uia', window: { title: { value: 'RPA-Windows-' + title, match: 'exact' } }, path: [{ axis: 'descendant', properties: { Name: { value: name, match: 'exact' }, ...(name === '城市' ? { ControlType: { value: 'ComboBox', match: 'exact' as const } } : {}) } }] }),
    call: method => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error('Fixture command timeout')); }, 5000); pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: cause => { clearTimeout(timer); reject(cause); } }); child.stdin.write(JSON.stringify({ id, method }) + '\n'); }),
    close: async () => { child.stdin.end(); if (child.exitCode === null) await new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill(); resolve(); }, 1500); child.once('exit', () => { clearTimeout(timer); resolve(); }); }); lines.close(); },
  };
}
