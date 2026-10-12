// This helper owns every AutomationElement on one MTA thread. Only JSON leaves it.
export const windowsHostScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RpaWindowsNative {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int mode);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [StructLayout(LayoutKind.Sequential)] struct Point { public int x,y; }
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flag);
  public static IntPtr WindowAt(int x,int y) { return GetAncestor(WindowFromPoint(new Point { x=x, y=y }),2); }
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr process);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint first, uint second, bool attach);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr window);
  [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr window; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public int x,y; public uint extra; }
  [DllImport("user32.dll")] static extern bool PeekMessage(out Message message, IntPtr window, uint min, uint max, uint remove);
  public static void Activate(IntPtr window) {
    Message message; PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
    uint current = GetCurrentThreadId();
    uint foreground = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint target = GetWindowThreadProcessId(window, IntPtr.Zero);
    bool attachedForeground = foreground != 0 && foreground != current && AttachThreadInput(current, foreground, true);
    bool attachedTarget = target != 0 && target != current && target != foreground && AttachThreadInput(current, target, true);
    try { if (IsIconic(window)) ShowWindow(window,9); BringWindowToTop(window); SetForegroundWindow(window); }
    finally { if (attachedTarget) AttachThreadInput(current,target,false); if (attachedForeground) AttachThreadInput(current,foreground,false); }
  }
}
'@
[void][RpaWindowsNative]::SetProcessDpiAwarenessContext([IntPtr](-4))
function Fail($code, $message) { throw ($code + ': ' + $message) }
function Match($actual, $rule) {
  if ($null -eq $rule) { return $true }
  if ($rule.match -eq 'wildcard') { return [string]$actual -clike [string]$rule.value }
  return [string]$actual -ceq [string]$rule.value
}
function Prop($el, $name) {
  if ($name -eq 'ControlType') { return $el.Current.ControlType.ProgrammaticName.Replace('ControlType.', '') }
  return $el.Current.$name
}
function Attributes($el) {
  $result = @{}
  foreach ($name in @('AutomationId','Name','ControlType','ClassName','FrameworkId','ProcessId','IsEnabled','IsOffscreen','IsKeyboardFocusable','HasKeyboardFocus')) { $result[$name] = Prop $el $name }
  return $result
}
function Bounds($el) {
  $rect = $el.Current.BoundingRectangle
  if ($rect.IsEmpty) { return @{ x=0; y=0; width=0; height=0 } }
  return @{ x=$rect.X; y=$rect.Y; width=$rect.Width; height=$rect.Height }
}
function Windows($locator) {
  $found = New-Object 'System.Collections.Generic.List[System.Windows.Automation.AutomationElement]'
  $items = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($item in $items) {
    try {
      $processName = [System.Diagnostics.Process]::GetProcessById($item.Current.ProcessId).ProcessName
      if ((Match $processName $locator.processName) -and (Match $item.Current.Name $locator.title) -and (Match $item.Current.ClassName $locator.className)) { $found.Add($item) }
    } catch [System.Windows.Automation.ElementNotAvailableException] {} catch [System.ArgumentException] {}
  }
  return ,$found.ToArray()
}
function Children($el) {
  $list = New-Object 'System.Collections.Generic.List[System.Windows.Automation.AutomationElement]'
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $child = $walker.GetFirstChild($el)
  while ($null -ne $child) { $list.Add($child); $child = $walker.GetNextSibling($child) }
  return ,$list.ToArray()
}
function NodeMatches($el, $node) {
  foreach ($prop in $node.properties.PSObject.Properties) { if (!(Match (Prop $el $prop.Name) $prop.Value)) { return $false } }
  return $true
}
function NodeItems($parent, $node) {
  if ($node.axis -eq 'child') { $candidates = Children $parent }
  else { $candidates = $parent.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Automation]::ControlViewCondition) }
  $matches = @($candidates | Where-Object { NodeMatches $_ $node })
  if ($null -ne $node.index) {
    if ($node.index -lt $matches.Count) { return ,@($matches[$node.index]) }
    return ,@()
  }
  return ,$matches
}
function Elements($ref) {
  $parents = Windows $ref.window
  foreach ($node in $ref.path) {
    $next = New-Object 'System.Collections.Generic.List[System.Windows.Automation.AutomationElement]'
    foreach ($parent in $parents) { foreach ($item in (NodeItems $parent $node)) { $next.Add($item) } }
    $parents = $next.ToArray()
  }
  return ,@($parents)
}
function Unique($items) {
  if ($items.Count -eq 0) { Fail 'NOT_FOUND' '未找到窗口或元素' }
  if ($items.Count -ne 1) { Fail 'AMBIGUOUS' ('匹配到 ' + $items.Count + ' 个目标，请增加定位条件') }
  return $items[0]
}
function Ref($el) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $chain = New-Object 'System.Collections.Generic.List[System.Windows.Automation.AutomationElement]'
  $cursor = $el
  for ($depth=0; $depth -lt 42; $depth++) {
    $parent = $walker.GetParent($cursor)
    if ($null -eq $parent -or [System.Windows.Automation.Automation]::Compare($parent, [System.Windows.Automation.AutomationElement]::RootElement)) { break }
    $chain.Insert(0, $cursor); $cursor = $parent
  }
  if ($chain.Count -gt 40) { Fail 'UNSUPPORTED' '控件层级超过 40 层' }
  $processName = [System.Diagnostics.Process]::GetProcessById($cursor.Current.ProcessId).ProcessName
  $window = @{ processName=@{value=$processName;match='exact'}; title=@{value=$cursor.Current.Name;match='exact'}; className=@{value=$cursor.Current.ClassName;match='exact'} }
  if ($cursor.Current.ClassName -like 'WindowsForms10.Window.*') { $window.className=@{value='WindowsForms10.Window.*';match='wildcard'} }
  foreach ($key in @('title','className')) { if ([string]::IsNullOrEmpty($window[$key].value)) { $window.Remove($key) } }
  $path = @(); $parent = $cursor
  foreach ($child in $chain) {
    $props = @{ ControlType=@{value=(Prop $child 'ControlType');match='exact'} }
    if ($child.Current.AutomationId) { $props.AutomationId=@{value=$child.Current.AutomationId;match='exact'} }
    else {
      if ($child.Current.Name) { $props.Name=@{value=$child.Current.Name;match='exact'} }
      if ($child.Current.ClassName) { $props.ClassName=@{value=$child.Current.ClassName;match='exact'} }
    }
    $node = @{axis='child';properties=$props}
    $nodeObject = ($node | ConvertTo-Json -Depth 15 -Compress | ConvertFrom-Json)
    # NodeItems already returns one array object. Wrapping it again hides duplicates.
    $siblings = NodeItems $parent $nodeObject
    if ($siblings.Count -gt 1) {
      for ($i=0; $i -lt $siblings.Count; $i++) { if ([System.Windows.Automation.Automation]::Compare($siblings[$i],$child)) { $node.index=$i; break } }
    }
    $path += $node; $parent=$child
  }
  return @{ backend='uia';window=$window;path=@($path) }
}
function Snapshot($el) { return @{element=(Ref $el);attributes=(Attributes $el);bounds=(Bounds $el)} }
function Pattern($el, $name) {
  $type = [System.Windows.Automation.AutomationElement].Assembly.GetType('System.Windows.Automation.' + $name)
  $patternId = $type.GetField('Pattern').GetValue($null)
  $pattern = $null
  if (!$el.TryGetCurrentPattern($patternId, [ref]$pattern)) { Fail 'UNSUPPORTED' ('控件不支持 ' + $name + '，点击或输入可选择模拟操作') }
  return $pattern
}
function Text($el) {
  $pattern = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) { return $pattern.DocumentRange.GetText(-1) }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { return $pattern.Current.Value }
  return $el.Current.Name
}
function Execute($method, $p) {
  if ($method -eq 'inspect') {
    # Initialize the window provider before querying its child at a point. Otherwise
    # WinForms can initially expose a generic HWND proxy with a transient handle ID.
    $handle = [RpaWindowsNative]::WindowAt([int]$p.x,[int]$p.y)
    if ($handle -ne [IntPtr]::Zero) {
      $topLevel = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
      foreach ($window in $topLevel) {
        if ($window.Current.NativeWindowHandle -eq $handle.ToInt64()) {
          [void](Attributes $window)
          [void]$window.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Automation]::ControlViewCondition)
          break
        }
      }
    }
    $el = [System.Windows.Automation.AutomationElement]::FromPoint((New-Object System.Windows.Point($p.x, $p.y)))
    $snapshot = Snapshot $el
    if (@($p.excludeProcessIds) -contains $el.Current.ProcessId) { return $null }
    return $snapshot
  }
  if ($method -eq 'windows.findWindow') { $el = Unique (Windows $p.window); return (Snapshot $el) }
  $items = Elements $p.element
  if ($method -eq 'validate') { return @{count=$items.Count;matches=@($items | Select-Object -First 20 | ForEach-Object { Snapshot $_ })} }
  if ($method -eq 'windows.exists') { if ($items.Count -gt 1) { Unique $items | Out-Null }; return ($items.Count -eq 1) }
  if ($method -eq 'windows.wait') {
    $end = [DateTime]::UtcNow.AddMilliseconds($p.timeoutMs)
    do {
      if ($items.Count -gt 1) { Unique $items | Out-Null }
      $exists = $items.Count -eq 1
      if (($p.state -eq 'gone' -and !$exists) -or ($p.state -eq 'exists' -and $exists) -or ($p.state -eq 'visible' -and $exists -and !$items[0].Current.IsOffscreen)) { return $true }
      Start-Sleep -Milliseconds 100; $items = Elements $p.element
    } while ([DateTime]::UtcNow -lt $end)
    Fail 'TIMEOUT' '等待桌面元素超时'
  }
  $el = Unique $items
  if ($method -eq 'windows.find') { return (Snapshot $el) }
  if ($method -eq 'windows.text') { return (Text $el) }
  if ($method -eq 'windows.getAttribute') { return (Prop $el $p.name) }
  if ($method -eq 'windows.bounds') { return (Bounds $el) }
  if ($method -eq 'windows.related') {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    switch ($p.relation) {
      'parent' { $related = $walker.GetParent($el) }
      'children' { $refs=@(); foreach ($child in (Children $el)) { $refs += (Ref $child) }; return ,$refs }
      'child' { $children=Children $el; if ($p.index -ge $children.Count) { Fail 'NOT_FOUND' '子元素序号超出范围' }; $related=$children[$p.index] }
      'previous' { $related = $walker.GetPreviousSibling($el) }
      'next' { $related = $walker.GetNextSibling($el) }
    }
    if ($null -eq $related -or [System.Windows.Automation.Automation]::Compare($related,[System.Windows.Automation.AutomationElement]::RootElement)) { return $null }
    return (Ref $related)
  }
  if (!$el.Current.IsEnabled) { Fail 'UNAVAILABLE' '目标控件已禁用' }
  if ($method -eq 'prepare') {
    if ($el.Current.IsOffscreen) { Fail 'UNAVAILABLE' '目标控件不可见' }
    $window = Unique (Windows $p.element.window)
    $handle = [IntPtr]$window.Current.NativeWindowHandle
    if ([RpaWindowsNative]::IsIconic($handle)) { [void][RpaWindowsNative]::ShowWindow($handle,9) }
    [RpaWindowsNative]::Activate($handle)
    for ($attempt=0; $attempt -lt 10 -and [RpaWindowsNative]::GetForegroundWindow() -ne $handle; $attempt++) { Start-Sleep -Milliseconds 100 }
    if ([RpaWindowsNative]::GetForegroundWindow() -ne $handle) { Fail 'UNAVAILABLE' ('无法激活目标窗口，请检查桌面会话及权限（目标 ' + $handle + '，前台 ' + [RpaWindowsNative]::GetForegroundWindow() + '）') }
    $point = New-Object System.Windows.Point
    if (!$el.TryGetClickablePoint([ref]$point)) { Fail 'UNAVAILABLE' '控件没有可点击的位置' }
    if ($p.focus -and $el.Current.IsKeyboardFocusable) { $el.SetFocus() }
    return @{x=[int]$point.X;y=[int]$point.Y;expectedWindow=$handle.ToInt64()}
  }
  switch ($method) {
    'windows.click' { (Pattern $el 'InvokePattern').Invoke(); return @{ok=$true} }
    'windows.fill' {
      $pattern = Pattern $el 'ValuePattern'
      if ($pattern.Current.IsReadOnly) { Fail 'UNAVAILABLE' '输入框为只读' }
      $value = [string]$p.value
      if ($p.append) { $value = $pattern.Current.Value + $value }
      $pattern.SetValue($value); return @{ok=$true}
    }
    'windows.check' {
      $pattern = Pattern $el 'TogglePattern'
      $desired = if ($p.checked) { [System.Windows.Automation.ToggleState]::On } else { [System.Windows.Automation.ToggleState]::Off }
      for ($attempt=0; $attempt -lt 3 -and $pattern.Current.ToggleState -ne $desired; $attempt++) { $pattern.Toggle() }
      if ($pattern.Current.ToggleState -ne $desired) { Fail 'UNAVAILABLE' '无法设置复选框状态' }
      return @{ok=$true}
    }
    'windows.select' {
      $expand=$null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$expand)) { $expand.Expand() }
      try {
        $node = [pscustomobject]@{axis='descendant';properties=[pscustomobject]@{Name=$p.item;ControlType=[pscustomobject]@{value='ListItem';match='exact'}}}
        $item = Unique (NodeItems $el $node)
        (Pattern $item 'SelectionItemPattern').Select()
      } finally { if ($null -ne $expand) { $expand.Collapse() } }
      return @{ok=$true}
    }
    default { Fail 'UNSUPPORTED' ('不支持的 Windows 方法：' + $method) }
  }
}
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $request = $null
  try {
    $request = $line | ConvertFrom-Json
    $result = Execute $request.method $request.params
    $response = @{id=$request.id;result=$result}
  } catch {
    $message=$_.Exception.Message
    $cause=$_.Exception.GetBaseException()
    if ($cause -is [UnauthorizedAccessException] -or ($cause -is [System.Runtime.InteropServices.COMException] -and $cause.ErrorCode -eq -2147024891) -or ($cause -is [System.ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq 5)) { $message='PERMISSION: 权限不足，请使用与目标软件相同的权限运行' }
    elseif ($cause -is [System.Windows.Automation.ElementNotAvailableException]) { $message='NOT_FOUND: 控件已失效，请重新定位' }
    elseif ($cause -is [System.Windows.Automation.ElementNotEnabledException]) { $message='UNAVAILABLE: 目标控件已禁用或不可用' }
    $response=@{id=$request.id;error=$message}
  }
  [Console]::Out.WriteLine(($response | ConvertTo-Json -Depth 80 -Compress))
}
`;
