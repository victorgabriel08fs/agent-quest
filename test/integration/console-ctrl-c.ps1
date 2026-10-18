# Ajudante dos testes de integração (tester): emula o Ctrl+C de um console real.
#
# 1. Inicia $CommandLine num console novo e sem janela (CREATE_NO_WINDOW), com o
#    Ctrl+C habilitado para o processo filho (a flag "ignorar Ctrl+C" é herdada e
#    o executor dos testes pode tê-la ligada).
# 2. Espera o $RuntimeFile aparecer.
# 3. Manda CTRL_C_EVENT para o console inteiro com GenerateConsoleCtrlEvent(0, 0),
#    que é o mesmo evento que o console gera quando alguém aperta Ctrl+C.
# 4. Mede quando o arquivo some e quando o servidor sai, lê a tela do console e
#    encerra o que tiver sobrado.
#
# Saída: uma linha JSON (a tela vai em base64 de UTF-8). Não grava nada fora das
# pastas recebidas e não muda nenhuma configuração do sistema.

param(
  [Parameter(Mandatory = $true)][string]$CommandLine,
  [Parameter(Mandatory = $true)][string]$WorkDir,
  [Parameter(Mandatory = $true)][string]$RuntimeFile,
  [int]$StartTimeoutMs = 30000,
  [int]$WaitMs = 8000
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class AqConsole {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct SMALL_RECT { public short L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct CSBI { public COORD size; public COORD cursor; public short attr; public SMALL_RECT win; public COORD max; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleCtrlHandler(IntPtr h, bool add);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GenerateConsoleCtrlEvent(uint ev, uint group);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CSBI info);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ReadConsoleOutputCharacter(IntPtr h, StringBuilder buf, uint len, COORD at, out uint read);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);

  public static int Start(string cmd, string cwd) {
    SetConsoleCtrlHandler(IntPtr.Zero, false); // o filho herda "processar Ctrl+C", como num terminal normal
    var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    PROCESS_INFORMATION pi;
    if (!CreateProcess(null, new StringBuilder(cmd), IntPtr.Zero, IntPtr.Zero, false, 0x08000000, IntPtr.Zero, cwd, ref si, out pi))
      throw new System.ComponentModel.Win32Exception();
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    return pi.dwProcessId;
  }
  public static string Attach(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return "AttachConsole falhou: " + Marshal.GetLastWin32Error();
    SetConsoleCtrlHandler(IntPtr.Zero, true); // este processo ignora o Ctrl+C que vai mandar
    return "ok";
  }
  public static string CtrlC() { return GenerateConsoleCtrlEvent(0, 0) ? "ok" : "GenerateConsoleCtrlEvent falhou: " + Marshal.GetLastWin32Error(); }
  public static string Screen() {
    IntPtr h = CreateFile("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (h == new IntPtr(-1)) return "";
    CSBI info; GetConsoleScreenBufferInfo(h, out info);
    var sb = new StringBuilder();
    for (short y = 0; y <= info.cursor.Y; y++) {
      var line = new StringBuilder(info.size.X); uint read; var at = new COORD(); at.Y = y;
      ReadConsoleOutputCharacter(h, line, (uint)info.size.X, at, out read);
      sb.AppendLine(line.ToString(0, (int)read).TrimEnd());
    }
    CloseHandle(h);
    return sb.ToString().TrimEnd();
  }
  public static void Detach() { FreeConsole(); }
}
'@

function Get-Tree([int]$root) {
  $all = @(Get-CimInstance Win32_Process)
  $ids = @($root); $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($p in $all) { if (($ids -contains $p.ParentProcessId) -and -not ($ids -contains $p.ProcessId)) { $ids += $p.ProcessId; $changed = $true } }
  }
  return $ids
}

$result = [ordered]@{ ok = $false; error = $null; serverPid = $null; port = $null; ctrlC = $null; removedMs = $null; serverExitMs = $null; serverExitCode = $null; rootExited = $false; rootExitCode = $null; screen = '' }
$root = 0; $serverProc = $null; $rootProc = $null
try {
  $root = [AqConsole]::Start($CommandLine, $WorkDir)
  $rootProc = Get-Process -Id $root; $null = $rootProc.Handle
  $deadline = (Get-Date).AddMilliseconds($StartTimeoutMs)
  while (-not (Test-Path -LiteralPath $RuntimeFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 50 }
  if (-not (Test-Path -LiteralPath $RuntimeFile)) { throw 'o runtime.json não apareceu a tempo' }
  Start-Sleep -Milliseconds 800 # o servidor termina de imprimir e instala os tratadores de sinal
  $rt = Get-Content -LiteralPath $RuntimeFile -Raw | ConvertFrom-Json
  $result.serverPid = [int]$rt.pid; $result.port = [int]$rt.port
  $serverProc = Get-Process -Id $rt.pid; $null = $serverProc.Handle

  $attach = [AqConsole]::Attach([uint32]$root)
  if ($attach -ne 'ok') { throw $attach }
  $t0 = Get-Date
  $result.ctrlC = [AqConsole]::CtrlC()
  while (((Get-Date) - $t0).TotalMilliseconds -lt $WaitMs) {
    $elapsed = [int]((Get-Date) - $t0).TotalMilliseconds
    if ($null -eq $result.removedMs -and -not (Test-Path -LiteralPath $RuntimeFile)) { $result.removedMs = $elapsed }
    if ($null -eq $result.serverExitMs -and $serverProc.HasExited) { $result.serverExitMs = $elapsed }
    if ($null -ne $result.serverExitMs -and $rootProc.HasExited) { break }
    Start-Sleep -Milliseconds 20
  }
  $screen = [AqConsole]::Screen()
  [AqConsole]::Detach()
  $result.screen = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($screen))
  if ($serverProc.HasExited) { $result.serverExitCode = $serverProc.ExitCode }
  $result.rootExited = $rootProc.HasExited
  if ($rootProc.HasExited) { $result.rootExitCode = $rootProc.ExitCode }
  $result.ok = $true
} catch {
  $result.error = "$($_.Exception.Message)"
  try { [AqConsole]::Detach() } catch { }
} finally {
  if ($root -and $rootProc -and -not $rootProc.HasExited) {
    foreach ($id in (Get-Tree $root)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
  }
  if ($serverProc -and -not $serverProc.HasExited) { Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue }
}
$result | ConvertTo-Json -Compress
