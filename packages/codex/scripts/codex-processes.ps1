function Get-CodexStorePackage {
  @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue |
    Sort-Object { [version]$_.Version } -Descending |
    Select-Object -First 1)[0]
}

function Test-CodexPathWithinRoot {
  param(
    [string]$Path,
    [string]$Root
  )

  if (-not $Path -or -not $Root) { return $false }
  try {
    $normalizedPath = [System.IO.Path]::GetFullPath($Path)
    $normalizedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    return $normalizedPath.StartsWith($normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase)
  } catch {
    return $false
  }
}

function Get-CodexMainProcesses {
  param([string]$PackageInstallLocation = '')

  $currentSessionId = (Get-Process -Id $PID -ErrorAction Stop).SessionId
  $results = @()
  foreach ($processInfo in @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" -ErrorAction SilentlyContinue)) {
    if ([int]$processInfo.SessionId -ne [int]$currentSessionId) { continue }
    $commandLine = [string]$processInfo.CommandLine
    if ($commandLine -match '(?:^|\s)--type(?:=|\s)') { continue }

    $process = Get-Process -Id ([int]$processInfo.ProcessId) -ErrorAction SilentlyContinue
    if (-not $process -or $process.HasExited) { continue }
    $executablePath = [string]$processInfo.ExecutablePath
    if (-not $executablePath) {
      try { $executablePath = [string]$process.Path } catch {}
    }
    $mainWindowHandle = $process.MainWindowHandle
    $packageOwned = Test-CodexPathWithinRoot -Path $executablePath -Root $PackageInstallLocation
    $hasVisibleWindow = $mainWindowHandle -ne [IntPtr]::Zero

    # Store updates can leave an inaccessible, windowless ChatGPT.exe from an
    # older package version behind. It is not the active Codex window and must
    # not prevent the new package from starting with the workbench parameters.
    if (-not $packageOwned -and -not $hasVisibleWindow) { continue }

    $results += [pscustomobject]@{
      ProcessId = [int]$processInfo.ProcessId
      CommandLine = $commandLine
      ExecutablePath = $executablePath
      MainWindowHandle = $mainWindowHandle
      SessionId = [int]$processInfo.SessionId
      PackageOwned = [bool]$packageOwned
      HasVisibleWindow = [bool]$hasVisibleWindow
    }
  }
  @($results)
}

function Find-CodexDesktopCliExecutable {
  if (-not $env:LOCALAPPDATA) { return '' }
  $binRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
  if (-not (Test-Path -LiteralPath $binRoot -PathType Container)) { return '' }
  foreach ($directory in @(Get-ChildItem -LiteralPath $binRoot -Directory -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending)) {
    $candidate = Join-Path $directory.FullName 'codex.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  return ''
}
