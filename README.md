# copilot-proxy

A local OpenAI-compatible HTTP endpoint backed by your GitHub Copilot subscription. It uses published Pi OAuth code for explicit device login and token refresh, then relays requests directly to Copilot.

Requires Node.js **22.19.0 or newer**, npm, a GitHub.com account with Copilot access, and a model enabled for that account. This is an unofficial integration, not a GitHub-supported API gateway. It does not grant access beyond your subscription or bypass organization policies, premium-request billing, quotas, or rate limits. Check the current [Copilot terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot) and your organization's rules before using it.

## Quickstart

Install the packaged release globally, then run it from your terminal. See [Packaging and publishing](#packaging-and-publishing) to create the tarball from this source:

```text
npm install --global ./copilot-proxy-0.1.0.tgz
copilot-proxy login --accept-model-policy-changes
copilot-proxy start --port 4141
```

npm installs the `copilot-proxy` command on Windows, macOS, and Linux; no manual shell alias is needed. The npm global binary directory must be on your `PATH`. Running `copilot-proxy` without a command also starts the server. Use `copilot-proxy --help` for all options and `copilot-proxy --version` to check the installed version.

The public npm registry already contains a package named `copilot-proxy`. This project has not been published there. Use this project's tarball until you have confirmed a registry release belongs to this project; `npm install --global copilot-proxy` currently selects the existing registry package.

You can also install the tarball locally in a project and run the command with `npx`:

```text
npm install ./copilot-proxy-0.1.0.tgz
npx --no-install copilot-proxy login --accept-model-policy-changes
npx --no-install copilot-proxy start --port 4141
```

Login prints a GitHub verification URL and a short-lived device code. Complete that flow in your browser. The acknowledgment flag is required because Pi login may enable currently unconfigured known Copilot models. It never enables models explicitly disabled by policy. Refresh does not change model policies. Neither startup nor `GET /health` starts login.

Leave the server running. Its output includes the actual listening address and commands to copy into your client terminal. `--port 0` chooses a free port and prints that port, not zero.

### Windows PowerShell

In a second PowerShell terminal:

```powershell
$env:OPENAI_BASE_URL = 'http://127.0.0.1:4141/v1'
$env:OPENAI_API_BASE = $env:OPENAI_BASE_URL
$env:OPENAI_API_KEY = 'copilot-proxy'

Invoke-RestMethod 'http://127.0.0.1:4141/health'
$catalog = Invoke-RestMethod "$env:OPENAI_BASE_URL/models"
$catalog.data | Select-Object id

# Example only: choose a Chat Completions model your account supports.
$model = 'gpt-4.1'
$body = @{
  model = $model
  messages = @(@{ role = 'user'; content = 'Write a JavaScript add function.' })
} | ConvertTo-Json -Depth 10
Invoke-RestMethod "$env:OPENAI_BASE_URL/chat/completions" `
  -Method Post -ContentType 'application/json' -Body $body
```

### bash

In a second bash terminal:

```bash
export OPENAI_BASE_URL='http://127.0.0.1:4141/v1'
export OPENAI_API_BASE="$OPENAI_BASE_URL"
export OPENAI_API_KEY='copilot-proxy'

curl --fail-with-body http://127.0.0.1:4141/health
curl --fail-with-body "$OPENAI_BASE_URL/models"

# Example only: choose a Chat Completions model your account supports.
curl --fail-with-body "$OPENAI_BASE_URL/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4.1","messages":[{"role":"user","content":"Write a JavaScript add function."}]}'
```

For streaming, add `"stream":true` and `"stream_options":{"include_usage":true}` to the Chat Completions body and use `curl -N`. Usage is present only when the selected upstream endpoint/model supplies it.

Print environment commands again with:

```text
copilot-proxy env --port 4141 --shell powershell
copilot-proxy env --port 4141 --shell bash
```

These commands print shell setup; they cannot change the parent terminal's environment. Copy their output. For an ephemeral port, supply the actual port shown at startup.

## Client setup and model choice

Clients that honor `OPENAI_BASE_URL` and `OPENAI_API_KEY` can use the endpoint above. A dummy key satisfies clients that require a nonempty key when local bearer authentication is off. Other clients need their own provider configuration. Never give clients your GitHub OAuth or Copilot access tokens.

[Aider](https://aider.chat/docs/llms/openai-compat.html) reads `OPENAI_API_BASE`, which the proxy's environment output also includes:

```text
aider --model openai/gpt-4.1
```

Use a model your account exposes that supports Chat Completions. For a client that uses Responses, configure this same base URL with its OpenAI Responses provider. For example, a [Codex custom provider](https://developers.openai.com/codex/config-advanced) can use the following configuration in the client's own config file:

```toml
model_provider = "local_copilot"
model = "YOUR_RESPONSES_MODEL_ID"

[model_providers.local_copilot]
name = "Local Copilot"
base_url = "http://127.0.0.1:4141/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
```

Replace the model placeholder with an account-enabled Responses model. The proxy does not edit client configuration. Clients requiring Responses WebSockets or extra API routes are not supported.

`GET /v1/models` returns the live, authenticated Copilot catalog with an OpenAI `object: "list"` envelope and `object: "model"`, `created`, and `owned_by` fields on each entry. Copilot's extra metadata is preserved. Missing creation times use `0`; missing ownership uses the vendor or `github-copilot`.

The catalog is not a promise that every listed model works with every API. It can include models requiring a different protocol. In the pinned Pi catalog, GPT-5 models use Responses, GPT-4.1 and several Gemini models use Chat Completions, and most Claude models use Anthropic Messages. **This proxy does not implement Anthropic `/v1/messages`.** Check the returned model metadata and Copilot's current availability; do not choose Claude merely because it appears in the list.

Specify `model` in each request or set `COPILOT_PROXY_MODEL` / `--model`. There is no guessed default. The proxy does not silently substitute models, convert requests between protocols, or retry failed generation requests.

## Supported API

| Route | Behavior |
| --- | --- |
| `GET /health` | Local liveness only. No credentials loaded and no upstream call. |
| `GET /v1/models` | Authenticated, live Copilot catalog. |
| `POST /v1/chat/completions` | JSON or OpenAI SSE, including tool calls/results, tool argument deltas, finish reasons and usage. |
| `POST /v1/responses` | HTTP JSON or Responses SSE for models supporting that endpoint. Tool items and events pass through. |

Successful generation JSON bodies and message content pass through without translation. Responses SSE streams retain the first provider-issued response ID and item ID per `output_index` throughout added, delta, done, and completed events. This repairs Copilot streams that re-encode IDs per event, which otherwise produce duplicate progress messages in Codex. Stable SSE frames remain byte-for-byte unchanged. Tool `call_id` values, encrypted reasoning, and request bodies are preserved for conversation replay. The proxy preserves parameters such as `tools`, `tool_choice`, `stream_options`, reasoning settings and `response_format`; the upstream model decides which ones it accepts. Image content is forwarded and marked for Copilot when present. No guarantee is made that every OpenAI feature or coding agent is compatible.

Unsupported APIs include Anthropic Messages, legacy Completions, embeddings, audio, images generation, files, batches, Assistants, Responses retrieval/deletion, and WebSocket transports. Only Responses creation over HTTP is implemented. The proxy does not implement server-side conversation storage; upstream support determines whether `store` or `previous_response_id` works.

Errors use an OpenAI-shaped `error` object. Upstream failure status and selected rate-limit/request-ID headers are preserved, but raw upstream error bodies are replaced with a safe message to avoid leaking tokens. A timeout returns HTTP 504 before streaming starts. After streaming starts, failures produce a final SSE error without a fake `[DONE]` success marker. A client disconnect aborts its upstream request. Shared refresh continues for other waiting clients.

## Configuration

CLI options override environment values.

| CLI option | Environment variable | Default |
| --- | --- | --- |
| `--host` | `COPILOT_PROXY_HOST` | `127.0.0.1` |
| `--port` | `COPILOT_PROXY_PORT` | `4141` |
| `--model` | `COPILOT_PROXY_MODEL` | None, request must specify it |
| `--api-key` | `COPILOT_PROXY_API_KEY` | No local bearer requirement |
| `--auth-file` | `COPILOT_PROXY_AUTH_FILE` | Private OS-specific location below |
| `--max-body-bytes` | `COPILOT_PROXY_MAX_BODY_BYTES` | `512000000`, 512 MB (also the maximum) |
| `--timeout-ms` | `COPILOT_PROXY_TIMEOUT_MS` | `300000`, whole request including streaming |
| `--shell` | None | `both` |

### Codex: HTTP 413 Payload Too Large

`Request body exceeds 2097152 bytes` comes from the old 2 MiB default. The proxy rejects the request before contacting Copilot. Conversation history, tool results, or inline images can make Codex Responses requests exceed that limit. The default and maximum are now 512 MB; startup prints the effective limit.

OpenAI's [image-input requirements](https://developers.openai.com/api/docs/guides/images-vision#image-input-requirements) documented up to **512 MB total payload per request** when checked September 6, 2026. The proxy uses decimal MB (`512000000` bytes), which stays below Node's single-string ceiling when parsing ASCII JSON. The [Codex configuration reference](https://developers.openai.com/codex/config-reference/) describes model context and compaction in tokens, without specifying a universal HTTP request byte maximum. Copilot's own request and model limits still apply.

Reinstall this project's updated package before restarting a globally installed proxy: older versions reject values above 64 MiB. Stop the existing server and start the updated copy, preserving any other options you use:

```text
copilot-proxy start --port 4141 --max-body-bytes 512000000
```

Alternatively, set `COPILOT_PROXY_MAX_BODY_BYTES=512000000` in the **proxy's** environment before starting it. CLI options override the environment. Editing this checkout or changing the client's environment does not update a running, globally installed proxy. Use `npm start` to run the updated source directly from this checkout.

The allowed range is 1 through `512000000` bytes. Reduce large tool outputs or images, or compact the conversation, for requests above that ceiling. This byte limit is separate from model token/context limits. The proxy buffers and parses JSON in memory, so large requests can use several times their body size in RAM; configure a lower limit on constrained machines.

### Local access

Only `127.0.0.1`, `localhost`, and `::1` are accepted. `localhost` binds `127.0.0.1`. Remote binds are refused even with an API key. Browser-origin requests are rejected; there are no CORS allowances. Host checking also rejects DNS-rebinding hostnames.

To require a local key, set `COPILOT_PROXY_API_KEY` in the server terminal before starting, then set the same value as `OPENAI_API_KEY` in each client terminal. Add `Authorization: Bearer <your-local-key>` to curl/PowerShell API calls. `/health` remains unauthenticated. Prefer the environment variable to putting a key in shell history via `--api-key`. Startup and `env` print a placeholder rather than revealing the key.

Loopback binding is not isolation from other local users or programs. Enable the local key on shared machines. Do not publish this port through a tunnel, reverse proxy, or container port mapping.

## Credentials and Pi reuse

The only direct dependency is the pinned, verified compatible release [`@earendil-works/pi-ai@0.84.4`](https://www.npmjs.com/package/@earendil-works/pi-ai/v/0.84.4). Pi's package includes transitive SDK dependencies for providers this proxy does not otherwise use.

`src/pi.js` imports the public `githubCopilotProvider` from `@earendil-works/pi-ai/providers/github-copilot`. The proxy calls `provider.auth.oauth.login`, `refresh`, and `toAuth`. Pi owns device OAuth, access-token refresh, the account endpoint derived from the token, and the bundled Copilot identity headers from `provider.getModels()`. The small request adapter classifies the last role and image content for Copilot's dynamic headers. It does not translate message content into Pi's message format.

See Pi's [published OAuth implementation](https://cdn.jsdelivr.net/npm/@earendil-works/pi-ai@0.84.4/dist/auth/oauth/github-copilot.js) and [auth declarations](https://cdn.jsdelivr.net/npm/@earendil-works/pi-ai@0.84.4/dist/auth/types.d.ts). This is why the proxy relays upstream HTTP rather than translating Pi streaming events back into OpenAI events: direct relay preserves tools, deltas, usage, and provider-specific parameters.

Credentials are separate from Pi's own store and are never auto-discovered or imported:

- Windows: `%LOCALAPPDATA%\copilot-proxy\auth.json`, falling back to the user's `AppData\Local`.
- macOS/Linux: `$XDG_CONFIG_HOME/copilot-proxy/auth.json`, or `~/.config/copilot-proxy/auth.json`.

The default store also works when you run the installed command from your home directory. A custom `--auth-file` / `COPILOT_PROXY_AUTH_FILE` override must remain outside the current working directory. Writes use a private temporary file and atomic rename. POSIX files have mode `0600`; Windows writes remove inherited ACL entries and grant only the current Windows user access before writing credential contents. Tokens and request bodies are not logged. The device code is shown only during explicit login.

Refreshes are deduplicated within a process and saved before use. Run one proxy process per credential file; cross-process refresh coordination is not implemented. If login expires or is revoked, rerun the explicit login command. To sign out locally, stop the server and delete that specific proxy credential file; revoke the OAuth grant in GitHub settings if necessary. Only GitHub.com accounts are supported, not GitHub Enterprise Server/custom enterprise domains.

## Development

```text
npm ci
npm run check
npm test
npm run test:package
```

To run directly from a source checkout:

```text
npm run login -- --accept-model-policy-changes
npm start -- --port 4141
```

Plain ESM runs directly, so there is no build step. Tests use Node's built-in test runner and fake credentials/upstream responses. Routine tests never use your account, initiate device login, or spend subscription requests. They cover HTTP transport, tool/SSE preservation, refresh concurrency, private persistence, failure handling and CLI configuration. Live login and model availability still require an account-dependent smoke test that you choose to run.

The project `.npmrc` omits registry-specific tarball URLs from the lockfile while retaining versions and integrity hashes. Installs use your configured npm registry, so the lockfile does not force another developer onto a corporate mirror. No TLS or npm trust settings are relaxed.

## Packaging and publishing

Create an installable tarball from the source folder:

```text
npm pack
npm install --global ./copilot-proxy-0.1.0.tgz
copilot-proxy login --accept-model-policy-changes
copilot-proxy start
```

The tarball contains the runtime JavaScript, package metadata, and this README. Tests, local outputs, credentials, and `node_modules` are excluded; npm installs the declared dependencies for consumers. `npm run test:package` packs the project, installs it into an isolated temporary global prefix, and exercises the installed command from another directory, including startup and the login acknowledgment check. It may download dependencies, but does not log in or contact Copilot.

The unscoped name `copilot-proxy` is already registered on npm. Publishing under that name requires ownership; alternatively, change the package name to an available scoped name while keeping `bin.copilot-proxy` so the command stays the same. To release with an account that owns the chosen package name:

```text
npm publish --access public --registry=https://registry.npmjs.org
```

The publish hook runs syntax checks, unit/integration tests, and the package installation smoke test first. Creating or installing the tarball does not publish it; registry installation by name requires a published release. For later releases, update the package version with `npm version patch` (or `minor` / `major`) before packing or publishing.
