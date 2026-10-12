/** Embedded in the input host; hooks ignore Windows-injected events. */
export const inputGuardMembers = String.raw`
  delegate IntPtr HookCallback(int code, IntPtr message, IntPtr data);
  [StructLayout(LayoutKind.Sequential)] struct KeyboardHook { public uint vk, scan, flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MouseHook { public Point point; public uint data, flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct HookMessage { public IntPtr window; public uint message; public UIntPtr w; public IntPtr l; public uint time; public Point point; }
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetWindowsHookEx(int id, HookCallback callback, IntPtr module, uint thread);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
  [DllImport("user32.dll")] static extern int GetMessage(out HookMessage message, IntPtr window, uint min, uint max);
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint message, UIntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  static HookCallback keyboardHook, mouseHook;
  static Thread hookThread;
  static uint hookThreadId;
  static int realInput;
  static string physicalSource="";
  static int ownedX=int.MinValue, ownedY=int.MinValue;
  static UIntPtr ownerMarker=new UIntPtr(0x52504111);
  static IntPtr initialForeground;
  static EventWaitHandle cancelEvent;
  static System.Collections.Generic.HashSet<byte> heldKeys = new System.Collections.Generic.HashSet<byte>();
  static uint heldMouse;
  public static void BeginOwnership(string cancelName) {
    realInput=0; initialForeground=GetForegroundWindow();
    cancelEvent = new EventWaitHandle(false, EventResetMode.ManualReset, cancelName);
    ManualResetEvent ready = new ManualResetEvent(false);
    Exception failure=null;
    hookThread = new Thread(() => {
      hookThreadId=GetCurrentThreadId();
      keyboardHook=(code,message,data) => { if(code>=0) { KeyboardHook value=Marshal.PtrToStructure<KeyboardHook>(data); if((value.flags & 0x10)==0 && value.extra!=ownerMarker) { physicalSource="key:"+message+":"+value.vk; Interlocked.Exchange(ref realInput,1); } } return CallNextHookEx(IntPtr.Zero,code,message,data); };
      mouseHook=(code,message,data) => { if(code>=0) { MouseHook value=Marshal.PtrToStructure<MouseHook>(data); if((value.flags & 0x01)==0 && value.extra!=ownerMarker) { physicalSource="mouse:"+message+":"+value.flags+":"+value.point.x+","+value.point.y; Interlocked.Exchange(ref realInput,1); } } return CallNextHookEx(IntPtr.Zero,code,message,data); };
      IntPtr keyboard=SetWindowsHookEx(13,keyboardHook,GetModuleHandle(null),0), mouse=SetWindowsHookEx(14,mouseHook,GetModuleHandle(null),0);
      if(keyboard==IntPtr.Zero || mouse==IntPtr.Zero) failure=new Win32Exception(Marshal.GetLastWin32Error(),"无法监测真实键鼠输入");
      ready.Set();
      try { HookMessage message; while(failure==null && GetMessage(out message,IntPtr.Zero,0,0)>0) {} }
      finally { if(keyboard!=IntPtr.Zero) UnhookWindowsHookEx(keyboard); if(mouse!=IntPtr.Zero) UnhookWindowsHookEx(mouse); }
    });
    hookThread.IsBackground=true; hookThread.Start();
    if(!ready.WaitOne(3000)) throw new InvalidOperationException("真实输入监测启动超时");
    if(failure!=null) throw failure;
  }
  static void CheckOwnership() {
    if(cancelEvent!=null && cancelEvent.WaitOne(0)) throw new InvalidOperationException("INPUT_CANCELLED: 电脑输入已取消");
    if(Volatile.Read(ref realInput)!=0 || initialForeground!=IntPtr.Zero && GetForegroundWindow()!=initialForeground)
      throw new InvalidOperationException("INPUT_INTERRUPTED: 用户已接管电脑或目标窗口变化，指令可能部分完成 (source="+physicalSource+", own="+ownedX+","+ownedY+", before="+initialForeground+", after="+GetForegroundWindow()+")");
  }
  static void Pause(int milliseconds) {
    if(cancelEvent!=null && cancelEvent.WaitOne(Math.Max(0,milliseconds))) throw new InvalidOperationException("INPUT_CANCELLED: 电脑输入已取消");
    if(cancelEvent==null) Thread.Sleep(milliseconds);
    CheckOwnership();
  }
  public static void EndOwnership() {
    foreach(byte key in heldKeys) keybd_event(key,0,2,UIntPtr.Zero); heldKeys.Clear();
    if(heldMouse!=0) { Input[] inputs=new Input[1]; inputs[0].type=0; inputs[0].data.mouse.flags=heldMouse; SendInput(1,inputs,Marshal.SizeOf(typeof(Input))); heldMouse=0; }
    if(hookThreadId!=0) PostThreadMessage(hookThreadId,0x12,UIntPtr.Zero,IntPtr.Zero);
    if(hookThread!=null) hookThread.Join(1000);
    if(cancelEvent!=null) { cancelEvent.Dispose(); cancelEvent=null; }
  }
`;
