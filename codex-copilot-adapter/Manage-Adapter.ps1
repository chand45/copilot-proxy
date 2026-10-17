param([ValidateSet('Install','Check','Verify','Start','Stop','Status','EnableRouting','DisableRouting','RemoveStartup','Rollback')][string]$Action = 'Status')
$ErrorActionPreference = 'Stop'
$AdapterRoot = Join-Path $env:LOCALAPPDATA 'CodexCopilotAdapter'
$AdapterEntry = Join-Path $AdapterRoot 'adapter.mjs'
$SettingsFile = Join-Path $AdapterRoot 'settings.json'
$ProcessFile = Join-Path $AdapterRoot 'process.json'
$RoutingStateFile = Join-Path $AdapterRoot 'routing-state.json'
$ConfigFile = Join-Path $env:USERPROFILE '.codex\config.toml'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunName = 'CodexCopilotAdapter'
$ManagedLine = 'openai_base_url = "http://127.0.0.1:4142/v1"'
$RoutingPattern = '(?m)^[ \t]*(?:openai_base_url|"openai_base_url"|''openai_base_url'')[ \t]*=.*$'
$Utf8 = New-Object System.Text.UTF8Encoding($false)

if ($env:CODEX_HOME -and [IO.Path]::GetFullPath($env:CODEX_HOME).TrimEnd('\') -ine [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.codex')).TrimEnd('\')) {
    throw 'This package supports the default %USERPROFILE%\.codex location, not a custom CODEX_HOME.'
}

function Get-RoutingEntry([string]$Text) {
    if ($Text.Contains('"""') -or $Text.Contains("'''")) { throw 'Multiline TOML strings require a manual routing edit; no changes were made.' }
    $FirstTable = [regex]::Match($Text, '(?m)^[ \t]*\[')
    $RootEnd = if ($FirstTable.Success) { $FirstTable.Index } else { $Text.Length }
    $RootText = $Text.Substring(0,$RootEnd)
    $Matches = [regex]::Matches($RootText,$RoutingPattern)
    if ($Matches.Count -gt 1) { throw 'Multiple root openai_base_url entries; refusing an ambiguous edit.' }
    if ($Matches.Count) { return $Matches[0] }
    return $null
}

function Get-AdapterHealth {
    try { return Invoke-RestMethod -Uri 'http://127.0.0.1:4142/health' -TimeoutSec 2 } catch { return $null }
}
function Get-OwnedProcess([int]$AdapterPid) {
    $Candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $AdapterPid" -ErrorAction SilentlyContinue
    if (!$Candidate -or !$Candidate.CommandLine) { return $null }
    $Settings = Get-Content -LiteralPath $SettingsFile -Raw | ConvertFrom-Json
    if ($Candidate.ExecutablePath -ne $Settings.node -or $Candidate.CommandLine -notmatch [regex]::Escape($AdapterEntry)) { return $null }
    return $Candidate
}
function Start-Adapter {
    $Health = Get-AdapterHealth
    if ($Health) {
        if ($Health.service -eq 'codex-copilot-adapter' -and (Get-OwnedProcess $Health.pid)) { return $Health }
        throw 'Port 4142 is occupied by a different process.'
    }
    # Refresh the user-scoped key at every launch; never persist it in our files.
    $UserProxyKey = [Environment]::GetEnvironmentVariable('COPILOT_PROXY_KEY','User')
    if (!$UserProxyKey) { $UserProxyKey = [Environment]::GetEnvironmentVariable('COPILOT_PROXY_KEY','Machine') }
    if ($UserProxyKey) { $env:COPILOT_PROXY_KEY = $UserProxyKey }
    if (!$env:COPILOT_PROXY_KEY) { throw 'COPILOT_PROXY_KEY is not configured.' }
    $Settings = Get-Content -LiteralPath $SettingsFile -Raw | ConvertFrom-Json
    $Child = Start-Process -FilePath $Settings.node -ArgumentList ('"{0}"' -f $AdapterEntry) -WindowStyle Hidden -PassThru -WorkingDirectory $AdapterRoot -RedirectStandardOutput (Join-Path $AdapterRoot 'stdout.log') -RedirectStandardError (Join-Path $AdapterRoot 'stderr.log')
    for ($Attempt=0; $Attempt -lt 40; $Attempt++) {
        Start-Sleep -Milliseconds 150
        $Child.Refresh()
        if ($Child.HasExited) { throw 'Adapter exited at startup. Check stderr.log and adapter-events.jsonl.' }
        $Health = Get-AdapterHealth
        if ($Health -and $Health.pid -eq $Child.Id -and $Health.service -eq 'codex-copilot-adapter') {
            @{ pid=$Child.Id; startedTicks=$Child.StartTime.ToUniversalTime().Ticks.ToString() } | ConvertTo-Json | Set-Content -LiteralPath $ProcessFile -Encoding UTF8
            return $Health
        }
    }
    # Only terminate the child this invocation created.
    if (!$Child.HasExited) { $Child.Kill() }
    throw 'Adapter failed its startup health check.'
}
function Stop-Adapter {
    if (!(Test-Path -LiteralPath $ProcessFile)) { Write-Output 'No owned adapter process recorded.'; return }
    $State = Get-Content -LiteralPath $ProcessFile -Raw | ConvertFrom-Json
    $Candidate = Get-OwnedProcess $State.pid
    if (!$Candidate) { Write-Output 'Recorded adapter is no longer running.'; return }
    $ActualStart = (Get-Process -Id $State.pid).StartTime.ToUniversalTime().Ticks.ToString()
    $RecordedStart = if ($State.startedTicks) { $State.startedTicks } else { ([datetime]$State.started).ToUniversalTime().Ticks.ToString() }
    if ($ActualStart -ne $RecordedStart) { throw 'PID start time changed; refusing to stop an unrelated process.' }
    Stop-Process -Id $State.pid
    Remove-Item -LiteralPath $ProcessFile
    Write-Output 'Stopped the owned adapter process.'
}
function Edit-Routing([bool]$Enable) {
    $Original = [IO.File]::ReadAllText($ConfigFile)
    $Existing = Get-RoutingEntry $Original
    $PreviousLine = if ($Existing) { $Existing.Value.TrimEnd("`r") } else { $null }
    if ($Enable) {
        $null = Start-Adapter
        if ($PreviousLine -eq $ManagedLine) { Write-Output 'Adapter routing already enabled.'; return }
        if (Test-Path -LiteralPath $RoutingStateFile) { throw 'Saved routing state already exists. Inspect it before enabling again.' }
        $Backup = "$ConfigFile.copilot-adapter-$([guid]::NewGuid().ToString('N')).bak"
        $Updated = if ($Existing) { $Original.Remove($Existing.Index,$Existing.Length).Insert($Existing.Index,$ManagedLine) } else { "$ManagedLine`r`n$Original" }
        @{ previousLine=$PreviousLine; backup=$Backup; enabledAt=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $RoutingStateFile -Encoding UTF8
    } else {
        if (!(Test-Path -LiteralPath $RoutingStateFile)) { Write-Output 'No adapter routing change is recorded.'; return }
        if ($PreviousLine -ne $ManagedLine) { throw 'openai_base_url changed since installation. Refusing to overwrite the newer setting.' }
        $State = Get-Content -LiteralPath $RoutingStateFile -Raw | ConvertFrom-Json
        if ($null -ne $State.previousLine) {
            $Updated = $Original.Remove($Existing.Index,$Existing.Length).Insert($Existing.Index,$State.previousLine)
        } else {
            $RemoveLength = $Existing.Length
            if ($Original.Length -gt ($Existing.Index+$RemoveLength) -and $Original[$Existing.Index+$RemoveLength] -eq "`n") { $RemoveLength++ }
            $Updated = $Original.Remove($Existing.Index,$RemoveLength)
        }
        $Backup = "$ConfigFile.before-adapter-disable-$([guid]::NewGuid().ToString('N')).bak"
    }
    $TempConfig = "$ConfigFile.adapter-$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($TempConfig,$Updated,$Utf8)
        if ([IO.File]::ReadAllText($ConfigFile) -cne $Original) { throw 'Configuration changed during the edit. Retry after inspecting it.' }
        [IO.File]::Replace($TempConfig,$ConfigFile,$Backup)
    } catch {
        if ($Enable) { Remove-Item -LiteralPath $RoutingStateFile -ErrorAction SilentlyContinue }
        throw
    } finally { if (Test-Path -LiteralPath $TempConfig) { Remove-Item -LiteralPath $TempConfig } }
    if (!$Enable) { Remove-Item -LiteralPath $RoutingStateFile }
    Write-Output $(if ($Enable) { 'Enabled built-in openai routing through 127.0.0.1:4142.' } else { 'Restored the prior openai_base_url setting, preserving other config changes.' })
}

function Remove-AdapterStartup {
    $Startup = (Get-ItemProperty -LiteralPath $RunKey -Name $RunName -ErrorAction SilentlyContinue).$RunName
    if ($Startup -and $Startup -notmatch [regex]::Escape((Join-Path $AdapterRoot 'Manage-Adapter.ps1'))) { throw 'Startup value belongs to a different command; refusing to remove it.' }
    Remove-ItemProperty -LiteralPath $RunKey -Name $RunName -ErrorAction SilentlyContinue
    Write-Output 'Removed adapter startup at Windows sign-in.'
}

switch ($Action) {
    'Install' {
        & (Join-Path $PSScriptRoot 'Check-Prerequisites.ps1') | Format-List
        if ((Test-Path -LiteralPath $AdapterRoot) -and (Get-ChildItem -LiteralPath $AdapterRoot -Force)) { throw 'An adapter folder already exists. Use Status, Verify or Rollback to inspect the existing installation; this package does not upgrade it in place.' }
        if (Test-Path -LiteralPath $ConfigFile) { $null = Get-RoutingEntry ([IO.File]::ReadAllText($ConfigFile)) }
        if ((Get-ItemProperty -LiteralPath $RunKey -Name $RunName -ErrorAction SilentlyContinue).$RunName) { throw 'An adapter startup entry already exists. Inspect it before installing.' }
        $PortProbe = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,4142)
        try { $PortProbe.Start() } catch { throw 'Port 4142 is already in use. This package requires that port to be free.' } finally { $PortProbe.Stop() }
        $Node = (Get-Command node.exe -ErrorAction Stop).Source
        $null = New-Item -ItemType Directory -Path $AdapterRoot -Force
        foreach ($Name in @('adapter.mjs','Manage-Adapter.ps1','Check-Prerequisites.ps1','README.md')) {
            $Source = Join-Path $PSScriptRoot $Name
            $Destination = Join-Path $AdapterRoot $Name
            if ($Source -ne $Destination) { Copy-Item -LiteralPath $Source -Destination $Destination }
        }
        @{ node=$Node; installedFrom=$PSScriptRoot } | ConvertTo-Json | Set-Content -LiteralPath $SettingsFile -Encoding UTF8
        try {
            $null = Start-Adapter
            if (!(Test-Path -LiteralPath $ConfigFile)) { [IO.File]::WriteAllText($ConfigFile,'',$Utf8) }
            Edit-Routing $true
            & (Join-Path $PSScriptRoot 'Check-Prerequisites.ps1') -RequireAdapter | Format-List
            $StartupCommand = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Action Start' -f (Join-Path $AdapterRoot 'Manage-Adapter.ps1')
            if (!(Test-Path -LiteralPath $RunKey)) { $null = New-Item -Path $RunKey -Force }
            $null = New-ItemProperty -LiteralPath $RunKey -Name $RunName -Value $StartupCommand -PropertyType String -Force
        } catch {
            $InstallFailure = $_
            # Reverse only changes this fresh installation owns; retain files for diagnosis.
            try { if (Test-Path -LiteralPath $RoutingStateFile) { Edit-Routing $false } } catch { Write-Warning 'Automatic routing rollback failed. Run DisableRouting and inspect the saved backup before stopping the adapter.'; throw $InstallFailure }
            try { Remove-AdapterStartup; Stop-Adapter } catch { Write-Warning 'Some startup/process cleanup failed; inspect Status before retrying.' }
            throw $InstallFailure
        }
        Write-Output 'Installed the adapter and enabled hidden startup at Windows sign-in.'
    }
    'Check' { & (Join-Path $PSScriptRoot 'Check-Prerequisites.ps1') | Format-List }
    'Verify' { & (Join-Path $PSScriptRoot 'Check-Prerequisites.ps1') -RequireAdapter | Format-List }
    'Start' { Start-Adapter | ConvertTo-Json }
    'Stop' { Stop-Adapter }
    'Status' {
        $Health = Get-AdapterHealth
        $Startup = (Get-ItemProperty -LiteralPath $RunKey -Name $RunName -ErrorAction SilentlyContinue).$RunName
        $RootConfig = if (Test-Path -LiteralPath $ConfigFile) { [IO.File]::ReadAllText($ConfigFile) } else { '' }
        @{ health=$Health; startupEnabled=[bool]$Startup; routingEnabled=($RootConfig -match '(?m)^openai_base_url\s*=\s*"http://127\.0\.0\.1:4142/v1"\s*$'); installPath=$AdapterRoot } | ConvertTo-Json -Depth 5
    }
    'EnableRouting' { Edit-Routing $true }
    'DisableRouting' { Edit-Routing $false }
    'RemoveStartup' { Remove-AdapterStartup }
    'Rollback' { Edit-Routing $false; Remove-AdapterStartup; Stop-Adapter }
}
