param([switch]$RequireAdapter)
$ErrorActionPreference = 'Stop'

# Read-only. Credentials stay in memory and are never included in output.
$DefaultCodexHome = Join-Path $env:USERPROFILE '.codex'
if ($env:CODEX_HOME -and [IO.Path]::GetFullPath($env:CODEX_HOME).TrimEnd('\') -ine [IO.Path]::GetFullPath($DefaultCodexHome).TrimEnd('\')) {
    throw 'This package supports the default %USERPROFILE%\.codex location. A custom CODEX_HOME needs an adapted installation.'
}
$Node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (!$Node) { throw 'Install Node.js 24 or newer, then open a new PowerShell window so node.exe is on PATH.' }
$NodeVersion = & $Node -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [int]($NodeVersion.Split('.')[0]) -lt 24) { throw 'Node.js 24 or newer is required.' }
& $Node -e "if(typeof require('node:zlib').zstdDecompress!=='function')process.exit(1)"
if ($LASTEXITCODE -ne 0) { throw 'This Node.js build does not provide Zstandard decompression.' }

$AuthFile = Join-Path $DefaultCodexHome 'auth.json'
try { $Auth = Get-Content -LiteralPath $AuthFile -Raw | ConvertFrom-Json } catch { throw 'Sign in to Codex with ChatGPT on this desktop first. A readable .codex\auth.json is required.' }
if ($Auth.auth_mode -ne 'chatgpt' -or !$Auth.tokens.access_token) { throw 'The adapter requires ChatGPT sign-in stored in .codex\auth.json on this desktop.' }

$ProxyKey = [Environment]::GetEnvironmentVariable('COPILOT_PROXY_KEY','User')
if (!$ProxyKey) { $ProxyKey = [Environment]::GetEnvironmentVariable('COPILOT_PROXY_KEY','Machine') }
if (!$ProxyKey) { throw 'COPILOT_PROXY_KEY must be saved as a Windows user or machine environment variable, matching this desktop''s Copilot Proxy key. A terminal-only variable will not survive sign-in.' }
if ($ProxyKey -match '[\r\n]') { throw 'COPILOT_PROXY_KEY contains an invalid newline.' }
try {
    $Catalog = Invoke-RestMethod -Uri 'http://127.0.0.1:4141/v1/models' -Headers @{Authorization="Bearer $ProxyKey"} -TimeoutSec 15
    if ($null -eq $Catalog.data -or !($Catalog.data -is [Array])) { throw 'Invalid catalog' }
} catch { throw 'Copilot Proxy at 127.0.0.1:4141 did not accept the saved proxy key or return its model list. Check that it is running and signed in.' }

$ConfigFile = Join-Path $DefaultCodexHome 'config.toml'
if (Test-Path -LiteralPath $ConfigFile) {
    $Config = [IO.File]::ReadAllText($ConfigFile)
    # The installer performs a narrow text edit, not a general TOML rewrite.
    if ($Config.Contains('"""') -or $Config.Contains("'''")) { throw 'config.toml contains multiline strings. Automatic routing edits are intentionally disabled for this layout.' }
}

$Result = [ordered]@{nodeVersion=$NodeVersion; codexSignIn='available'; proxyCatalog='authenticated'; proxyModels=@($Catalog.data).Count; credentialsCopied=$false}
if ($RequireAdapter) {
    $AdapterRoot = Join-Path $env:LOCALAPPDATA 'CodexCopilotAdapter'
    try {
        $Health = Invoke-RestMethod -Uri 'http://127.0.0.1:4142/health' -TimeoutSec 3
        $Settings = Get-Content -LiteralPath (Join-Path $AdapterRoot 'settings.json') -Raw | ConvertFrom-Json
        $Candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($Health.pid)"
        $Entry = Join-Path $AdapterRoot 'adapter.mjs'
        if ($Health.service -ne 'codex-copilot-adapter' -or !$Candidate -or $Candidate.ExecutablePath -ine $Settings.node -or $Candidate.CommandLine -notmatch [regex]::Escape($Entry)) { throw 'Unrecognized adapter process' }
        $AdapterCatalog = Invoke-RestMethod -Uri 'http://127.0.0.1:4142/v1/models' -Headers @{Authorization="Bearer $($Auth.tokens.access_token)"} -TimeoutSec 20
        if ($null -eq $AdapterCatalog.models -or !($AdapterCatalog.models -is [Array])) { throw 'Invalid adapter catalog' }
    } catch { throw 'The installed adapter did not pass its authenticated catalog check. Run Manage-Adapter.ps1 -Action Status and inspect its local logs.' }
    $RootConfig = if ($Config) { ($Config -split '(?m)^[ \t]*\[',2)[0] } else { '' }
    if ($RootConfig -notmatch '(?m)^[ \t]*openai_base_url[ \t]*=[ \t]*"http://127\.0\.0\.1:4142/v1"[ \t]*(?:#.*)?\r?$') { throw 'The adapter is reachable, but the root openai_base_url setting is not enabled.' }
    $Result.adapterCatalog = 'authenticated through proxy'
    $Result.routing = 'enabled'
    $Result.inference = 'not tested; create a new phone chat to verify'
}
[pscustomobject]$Result
