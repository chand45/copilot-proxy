# Codex Remote to Copilot Proxy adapter

An optional adapter for a Windows desktop that already has Copilot Proxy working. The adapter has no npm dependencies. Its runtime and installation scripts were imported unchanged from the 17 October 2026 `codex-copilot-adapter-windows-v1.0.0.zip` package. `VERIFICATION.md` in the source folder records the original package checks.

```
Phone -> Codex Remote on the destination PC
      -> adapter at 127.0.0.1:4142
      -> that PC's Copilot Proxy at 127.0.0.1:4141
```

## Install on the other desktop

1. Install Node.js 24 or newer and open a new terminal. `node --version` must work.
2. Sign in to Codex with ChatGPT on that desktop and enable/connect its Codex Remote host.
3. Have Copilot Proxy running on `127.0.0.1:4141`, with its matching `COPILOT_PROXY_KEY` saved as a Windows user or machine environment variable. This is the adapter's variable; its value must match the proxy's `COPILOT_PROXY_API_KEY` or `--api-key` when local authentication is enabled. The installer verifies access without displaying the key. Keep the proxy's own automatic startup configured separately.
4. Clone this repository or copy this entire `codex-copilot-adapter` folder to the destination. Double-click **Install.cmd**, or run this from that folder in PowerShell:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Manage-Adapter.ps1 -Action Install
   ```

5. On your phone, select this destination Codex Remote host, create a **new** chat, and send `Reply with exactly PHONE_PROXY_OK`. Verify the reply. If the host keeps an old route, restart Codex and try a new chat again.

No administrator rights are required. Installation stops on missing prerequisites, a busy adapter port, an existing installation, or an ambiguous configuration. If transferring the folder as a ZIP, extract it before running the scripts. Windows policy may prevent unsigned scripts from running; this package does not change that policy persistently.

## What installation changes

- Copies the adapter and management files into `%LOCALAPPDATA%\CodexCopilotAdapter` for the current Windows user.
- Starts a hidden Node process and registers hidden startup at that user's Windows sign-in.
- Backs up `%USERPROFILE%\.codex\config.toml` and sets its top-level `openai_base_url` to `http://127.0.0.1:4142/v1`. If no config exists, it creates one.
- Checks authenticated model-list access through the adapter before registering startup. This checks credentials and connectivity; it does not prove model inference.

The route applies to **all chats using the built-in `openai` provider on that Windows user profile**. Existing custom provider settings, including Copilot Proxy and Azure, are preserved. The phone still connects through Codex Remote; neither local port needs to be exposed to the network.

No credentials, auth files, personal Codex settings, chats, model catalogs, logs, runtime installation paths, or registry state are copied from the source PC. The package discovers the destination's paths and uses its own sign-ins. Node.js, Codex and Copilot Proxy are not bundled.

## Check and operate

From this source folder, or `%LOCALAPPDATA%\CodexCopilotAdapter`:

```powershell
.\Manage-Adapter.ps1 -Action Check    # Read-only prerequisites and direct proxy catalog
.\Manage-Adapter.ps1 -Action Status   # Process health, startup and routing state
.\Manage-Adapter.ps1 -Action Verify   # Authenticated catalog through the installed adapter
.\Manage-Adapter.ps1 -Action Start
```

Logs are in `%LOCALAPPDATA%\CodexCopilotAdapter\adapter-events.jsonl` and `stderr.log`. The event log records routes, models and outcomes, with no prompts or credentials. `/health` alone does not prove upstream availability. After the phone test, the event log should show a `/v1/responses` forward followed by status 200 and `completed: true` for that request.

Run `node --test adapter.test.mjs` in this source folder to run its 10 local tests, using fake credentials and mock upstream servers. From the repository root, use `node --test codex-copilot-adapter/adapter.test.mjs`; the root `npm test` command also discovers these tests. They cover authentication, token rotation, header filtering, WebSocket fallback, decompression, request limits, streaming, cancellation, timeouts, model-list format, tool results and conversation history.

## Roll back

Double-click **Rollback.cmd** in this source folder, or run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Manage-Adapter.ps1 -Action Rollback
```

This restores the previous top-level `openai_base_url`, preserves unrelated config edits, removes the adapter's startup entry, and stops only its recorded process after checking its executable, script path and start time. If someone has changed the routing setting after installation, rollback stops and asks you to inspect it rather than overwrite that change.

Installed files and backups are retained. When installation originally created a config file, rollback leaves an empty config file. Restart Codex or create a new chat if an already-loaded chat retains the old route. For a reinstall after rollback, rename the retained `%LOCALAPPDATA%\CodexCopilotAdapter` folder after checking that its process has stopped; this installer intentionally does not upgrade a running adapter.

## Compatibility and limits

- Windows only; standard `%USERPROFILE%\.codex` auth/config location and ports 4141/4142. Custom `CODEX_HOME`, credential-store-only sign-in, custom ports, macOS and Linux need an adapted installer.
- The narrow config editor supports conventional TOML with single-line root settings. It refuses multiline-string configurations rather than risk a bad edit.
- The original phone flow was verified with Codex `0.163.0-alpha.10.2`. Its HTTP 426 response triggers Codex's HTTP/SSE fallback; Codex updates may change this behavior. Recheck new chats, tools and follow-up turns on each destination/version.
- The adapter decompresses Zstandard and gzip requests, replaces the local ChatGPT access token with the destination proxy key, and forwards `/v1/responses`. ChatGPT credentials and account headers are not sent to the proxy.
- The model list retains Codex's built-in model metadata. This package does not add models or guarantee that every model is available through your proxy/account.
- Request limits are 64 MiB compressed and decompressed, eight concurrent upstream requests, and five minutes. Separate compact/realtime endpoints are unsupported. Long conversations that use remote compaction are not verified.
- Startup occurs at user sign-in; this is not a Windows service with crash recovery. Copilot Proxy must be running too. If either process stops, requests fail; they do not silently switch providers.

This is a custom local workaround. The documented setting is [`openai_base_url`](https://learn.chatgpt.com/docs/config-file/config-reference), which overrides the built-in provider's base URL. Official [gateway compatibility guidance](https://learn.chatgpt.com/docs/enterprise/gateway-compatibility) explains why Responses streaming, continuation and tools need separate verification. The specific adapter behavior comes from the local implementation and tests, not an official Copilot integration guarantee.
