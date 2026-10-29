# DADUS AI

A local chat and AI-agent starter for DADUS AI: Angular UI, ASP.NET Core 8 / C# agents, EF Core 8 and SQL Server. The interface supports Unicode text in Marathi, Hindi, English and mixed language, with optional browser microphone dictation and spoken replies. Replies and tool summaries are escaped plain text.

Development starts in **Demo** mode. Demo replies are deterministic, visibly labelled, and do not call an AI model. Gemini and OpenAI replies require the selected provider's server-side key. This starter is for local development: anonymous browser sessions are separated, but account authentication is required before deployment. Real-time voice conversations, wake-word recognition, personal memory, reminders and mobile clients are later milestones.

## Prerequisites

- Node.js 24.15 or newer in the 24.x series and npm 11 or newer.
- .NET SDK 8.0.427 (pinned in `global.json`).
- Python 3 and Bash for the convenience scripts.
- Docker for local SQL Server Developer, or an existing SQL Server connection. Docker is unnecessary for the optional SQLite development demo.

The Codex cloud environment already has the tools. In a new cloud shell, run `source /workspace/.cloud-tools/chatbot-env.sh`. Each cloud task is isolated; use this checkout rather than creating another worktree.

## Install, build and test

From the repository root:

```bash
bash scripts/setup.sh
bash scripts/check.sh
```

Setup restores the pinned EF tool, installs locked .NET/npm dependencies, and builds both applications. Tests use isolated in-memory SQLite databases and fake provider transports; they do not send requests to OpenAI or require SQL Server. These tests do not establish SQL Server compatibility or live model access.

## Start the local demo now

The explicit SQLite development mode is useful when Docker or the SQL Server image is unavailable:

```bash
Database__Provider=Sqlite bash scripts/dev.sh all
```

This creates the development database under the ignored `.local/` directory, starts the API on loopback port 5088 and the Angular dev server on loopback port 4200. It applies the development schema before serving. Ctrl+C stops the app processes started by the script. History survives restarts in the same checkout. `python3 scripts/smoke.py` checks a running Demo API, persisted message pairs and anonymous-session isolation.

SQLite is restricted to `ASPNETCORE_ENVIRONMENT=Development`; SQL Server remains the default. The SQLite path uses `EnsureCreated` for this initial disposable schema, not SQL Server migrations. Future model changes require a deliberate SQLite migration/reset plan that preserves any wanted local history; startup never deletes a database automatically.

## Start with SQL Server

```bash
bash scripts/dev.sh all
```

The helper pulls a pinned official SQL Server 2022 image, runs the Developer edition after accepting its standard development EULA, binds SQL to `127.0.0.1:1433`, and verifies an authenticated `SELECT 1`. It generates the local password in memory and passes it to Docker without printing it or adding a credential file to the repository. The API connection string is injected into its process. SQL Server data is retained in the `dadus-sql-data` named volume. Ctrl+C leaves that data and the SQL container intact; `bash scripts/sql-server.sh stop` stops the managed database without deleting it.

If the container was removed while its volume remains, the helper refuses to reset it. Supply its original password securely as `DADUS_SQL_SA_PASSWORD` to recover it. Containers or volumes with unexpected ownership labels are left unchanged.

If you already have SQL Server, set `ConnectionStrings__Dadus` in your process environment and run the same command. The local helper trusts only the local SQL development certificate. Use normal certificate validation for a remote or deployed database.

The cloud network needs `mcr.microsoft.com` and Microsoft's regional image host `eastus.data.mcr.microsoft.com` for this pinned image. A saved network draft must be applied through environment settings before a blocked download can work. SQL Server integration must be validated separately if its image cannot be downloaded.

## Use Google Gemini with a free-tier project

1. Open [Google AI Studio's API key page](https://aistudio.google.com/app/apikey), sign in and create a Gemini API key for your project. Check the model's free-tier eligibility and quota in AI Studio; unlimited free access is not promised. A ChatGPT subscription or OpenAI key is unnecessary for Gemini mode.
2. In Visual Studio, right-click **Dadus.Api → Manage User Secrets**. Add the following section to the local JSON, preserving other settings, and replace the placeholder locally:

   ```json
   {
     "DadusGemini": {
       "ApiKey": "PASTE_YOUR_GEMINI_KEY_LOCALLY"
     }
   }
   ```

3. Stop the running backend with Ctrl+C or Visual Studio's Shift+F5. In the same **CMD** window that has your working SQL settings, run from the repository root:

   ```bat
   set "ASPNETCORE_ENVIRONMENT=Development"
   set "Chat__Mode=Gemini"
   dotnet run --project backend\Dadus.Api --no-launch-profile --urls http://127.0.0.1:5088
   ```

4. Keep Angular running, reconnect the UI and send a short message. The status and response badge should show **Gemini**. A browser refresh alone does not rebuild or restart the backend. Do not use `--no-build` after updating the provider code or initializing User Secrets.

The .NET agent loop calls Google's [OpenAI-compatible endpoint](https://github.com/google-gemini/cookbook/blob/main/quickstarts/Get_started_OpenAI_Compatibility.ipynb) at `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`. `DadusGemini__Model` defaults to `gemini-3.8-flash`, matching the current official cookbook example. Model availability and free-tier eligibility are determined by your Google project; if AI Studio offers a different eligible model, set its exact API model ID with `DadusGemini__Model` or `DadusGemini:Model` in User Secrets. The model example is not a pricing guarantee.

The Gemini key is separate from `DadusOpenAI:ApiKey`; do not paste a Gemini key into the OpenAI setting. Keys remain on the .NET server. In cloud settings, the corresponding secret variable is `DadusGemini__ApiKey`, with HTTPS access to `generativelanguage.googleapis.com`. Gemini quota/rate failures prompt you to check free-tier allowance and wait for it to reset; the app does not enable paid billing or automatically switch providers. A configured-key health status does not validate a real model call. Mocked provider tests do not establish live Gemini access.

## Enable real OpenAI replies

Configure `DadusOpenAI__ApiKey` securely in environment settings or the server process, allow HTTPS to `api.openai.com`, set `Chat__Mode=OpenAI`, and restart the API. `DadusOpenAI__Model` defaults to `gpt-4o-mini`; model availability depends on the account. The server uses the Chat Completions endpoint and disables response storage through `store=false`. This does not promise zero provider retention; check the provider's applicable data policy.

Never place the permanent API key in Angular, Git or chat messages. The application does not automatically load `.env`; `.env.example` only documents variable names. The cloud draft declares an optional personal key requirement targeting the custom server variable `DadusOpenAI__ApiKey`. `OPENAI_API_KEY` is reserved by the cloud platform, so this app uses the custom name.

No key is needed for Demo mode. The API reports missing live configuration as HTTP 503 and does not silently substitute a demo answer.

For Windows development, right-click **Dadus.Api → Manage User Secrets** in Visual Studio and add `DadusOpenAI:ApiKey` in the local JSON editor, preserving any existing settings. This initializes a local `UserSecretsId` when needed. Stop the backend before doing the following in its existing **CMD** window, keeping the working SQL environment:

```bat
set "ASPNETCORE_ENVIRONMENT=Development"
set "Chat__Mode=OpenAI"
dotnet run --project backend\Dadus.Api --no-launch-profile --urls http://127.0.0.1:5088
```

Run this from the repository root. Use a normal build after initializing User Secrets so the assembly includes the local secrets ID. Do not use `--no-build` for that first run. **OpenAI configured** means the key is present; send a message to verify that the account can actually call the model. OpenAI API billing is separate from a ChatGPT subscription.

Failed provider requests show fixed recovery guidance and preserve the draft:

| Code | Action |
| --- | --- |
| `provider_authentication_failed` | Replace the rejected backend API key in the local secret store. |
| `provider_access_denied` | Check the API project's permissions and model access. |
| `provider_quota_exceeded` | Check the selected provider's quota and project limits. For Gemini free tier, wait for allowance to reset; for OpenAI, check API billing and credits. |
| `provider_rate_limited` | Wait before retrying; check the project's API rate limits. |
| `provider_model_unavailable` | Check the selected provider's `DadusGemini__Model` or `DadusOpenAI__Model` against models available to its project. |
| `provider_unavailable` | Check connectivity from the .NET backend process; this is an unclassified transport failure. |
| `invalid_api_key_configuration` | Replace a placeholder or malformed key locally. Paste only the key value; outer whitespace is trimmed, while internal whitespace, controls and non-ASCII values are rejected before a request. |
| `provider_dns_failed` | Check the backend machine's DNS resolution with the network administrator. |
| `provider_connection_failed` | Check whether the .NET backend can connect to the provider over HTTPS. |
| `provider_tls_failed` | Check the PC clock and certificate trust. Keep TLS verification enabled. |
| `provider_proxy_failed` | Check the backend's configured proxy and its authentication with the network administrator. |
| `provider_service_unavailable` | The upstream service returned a server error. The UI shows its validated HTTP 5xx status; retry when the service recovers. |

The application never displays the raw provider error body or key. These diagnostics do not validate live access without a successful real chat request.

To investigate Gemini connectivity from Windows **CMD**, without sending your key:

```bat
curl.exe --max-time 10 http://127.0.0.1:5088/api/health
curl.exe -I --connect-timeout 10 --max-time 20 https://generativelanguage.googleapis.com/
```

The Google root URL can legitimately return HTTP 404; that proves an HTTPS response, not a successful authenticated model call. A healthy local API verifies database/key configuration, not live provider access. Curl and the .NET backend can have different proxy or network behavior, and a provider HTTP 5xx is distinct from a transport failure. Key-format validation and typed transport failures produce separate safe application codes; an upstream error includes only a numeric `providerStatus` in the 500–599 range. No diagnostic includes the provider response body or key. Do not bypass certificate verification to make a request succeed.

## Conversation language and interface

The interface uses a simple dark chat layout: conversation history and New conversation in the sidebar, an agent selector in the header, a centered message feed and a rounded composer at the bottom. DADUS keeps its own branding. Agent explanations and tool details expand when needed.

The composer's **Language** selector offers **मराठी**, **हिन्दी** and **English**. It now controls the requested AI reply language as well as microphone recognition and speech output. Marathi is the initial UI selection. Changing language applies to the next message in the same conversation, so you can switch between all three without losing the earlier exchange. Selecting Marathi or Hindi requests Devanagari replies even if earlier messages were English; code, names and quoted material can retain their original text.

The Companion agent's instructions favor direct, relaxed conversation, use the supplied chat context and avoid repeated greetings or canned workflows. Actual replies come from the selected live model. Tests verify language selection reaches its system prompt; they do not prove live model language quality. The API also accepts `language=auto`, which asks the model to follow the latest message, including Marathi or Hindi written in Roman letters. API callers that omit the field retain this automatic behavior.

After pulling this update, **rebuild and restart the backend** before testing the new language control. Browser refresh alone can leave an older API running that ignores the language field. Use your existing backend terminal so its working SQL, provider key and model settings remain available.

## Microphone and spoken replies

Choose Marathi, Hindi or English with **Language** beside the composer, then use **Mic** and allow microphone access in the browser. Starting Mic also enables **Read replies aloud**, so your question receives a spoken answer after you send it. Use **Stop dictation**, review the recognized text in the draft, and press **Send** yourself. Dictation never sends a message automatically. You can turn reading off before or while waiting for the reply; stopping dictation will not turn it back on. A recent Chrome or Edge on localhost is a useful starting point; recognition support, permissions and language availability depend on the browser and may require an internet connection. A recognition failure leaves manual text input available.

For a spoken exchange, choose **Voice chat**, speak, then press **Finish & send** (or Enter). This explicitly enables **Read replies aloud**, waits for final recognized words, sends the captured draft once, and reads the reply. **Cancel voice chat** retains captured text without sending. Silence, recognition errors and truncated drafts do not automatically submit an older or incomplete message. The next voice turn requires another click; the microphone never reopens after a reply.

Both microphone controls use continuous recognition, show tentative words beside **Hearing**, and can resume after the browser ends a short recognition run. A recording is limited to two minutes; repeated empty runs end with a notice. Stop, language/conversation changes and cancellation clear pending restarts. Only finalized words enter the draft.

Use **Test voice** first to hear a short fixed greeting. It works independently of the API, database and AI key, leaves your draft and conversation alone, and does not enable automatic reading or open the microphone. **Voice** selects an installed browser voice independently of the AI/microphone language. Auto prefers the selected language; if Marathi is missing but Hindi is available, it uses the Hindi voice and clearly warns that Marathi pronunciation may differ. An English voice is used for Marathi only if explicitly selected. Installing a Windows Marathi display language does not guarantee a Marathi speech voice in Chrome. No additional service or key is required for these controls.

Enable **Read replies aloud** to read new replies automatically, or use an existing assistant message's **Read aloud** control. Chrome can load voices after the page starts: the app waits briefly for them, offers Stop while preparing audio, and reports an error if playback never starts. Long replies are read in short Unicode-safe chunks. Blocked playback, missing voices and audio-device failures show a visible message above the composer. Use the button directly and check Chrome site sound permission, tab mute and Windows output volume when prompted. Marathi speech output is not guaranteed on every PC.

The application does not record or store audio. Browser speech recognition or synthesis may use the browser vendor's online speech services; only text submitted by Send or the explicit Finish & send action follows the normal chat/storage flow. The microphone is activated only by its button, and automatic reading starts off until enabled directly or through Mic or Voice chat. This is turn-by-turn dictation and reading, without wake words, background listening or real-time audio streaming. Voice tests use browser API mocks; actual microphone and voice availability must be checked on the user's device.

## AI agents in .NET

Keep the Angular interface and choose an agent before sending a message:

| Agent | Purpose |
| --- | --- |
| Companion | Everyday conversation in the user's language. |
| Planner | Break a goal into practical steps and explain tradeoffs. |
| Coding | Explain or review code and suggest fixes; it does not execute code. |

The agent engine is written in C# in `backend/Dadus.Api/Services`. In live mode it sends function definitions to OpenAI, runs supported tool calls on the server, feeds their results back to the model, and returns a final response. The loop has limits on model rounds, tool count, response sizes and elapsed time. Tools are limited to a bounded arithmetic calculator and the current time for an IANA time zone. There is no shell, filesystem, browser, email or external-action access.

In Demo mode, these commands exercise real local tools without calling an AI model:

```text
/calculate (12+3)*2
/time Asia/Kolkata
```

Ordinary demo replies remain labelled samples. A demo response is not evidence that a live AI model chose a tool. Tests use a fake HTTP transport to verify the live tool-call/result/final-response sequence without a provider key.

Changing the selected agent applies to the next message in the current conversation. Message history remains shared within that conversation. Tool summaries describe the latest completed run and are not stored in the conversation-history schema. Planner suggestions do not create reminders or perform tasks for the user. Live AI requires the secure key configuration described above.

## Windows / Visual Studio 2022

Install the pinned .NET 8 SDK and Node 24. Open `backend/Dadus.sln` in Visual Studio 2022 with .NET 8 support. Restore/build the solution and run `npm ci` in `frontend/dadus-web`. The `Dadus.Api` launch profile sets Development mode and API port 5088 for Visual Studio and ordinary `dotnet run`. The Angular client is a separate process on port 4200; running only the API does not start the chat UI.

For local SQL Express, set these variables in a PowerShell window using your actual instance and database:

```powershell
$env:ASPNETCORE_ENVIRONMENT = 'Development'
$env:ASPNETCORE_URLS = 'http://127.0.0.1:5088'
$env:ConnectionStrings__Dadus = 'Server=.\SQLEXPRESS;Database=Dadus;Integrated Security=True;Encrypt=True;TrustServerCertificate=True'
dotnet tool restore
dotnet run --project backend/Dadus.Api --no-launch-profile -- --migrate
dotnet run --project backend/Dadus.Api --no-launch-profile
```

For **Command Prompt (CMD)**, use `set` instead of PowerShell's `$env:` syntax. From the repository root:

```bat
set "ASPNETCORE_ENVIRONMENT=Development"
set "Database__Provider=SqlServer"
set "ConnectionStrings__Dadus=Server=.\SQLEXPRESS;Database=Dadus;Integrated Security=True;Encrypt=True;TrustServerCertificate=True"
dotnet run --project backend\Dadus.Api --no-launch-profile -- --migrate
```

Only after migration succeeds, run:

```bat
dotnet run --project backend\Dadus.Api --no-build --no-launch-profile --urls http://127.0.0.1:5088
```

If a build reports that `Dadus.Api.exe` is locked, stop the earlier backend with Ctrl+C or Visual Studio's Shift+F5 before rebuilding. Keep one backend instance running.

In a second PowerShell window, run `npm start` from `frontend/dadus-web`. The Angular proxy targets API port 5088. Windows account/SQL Express permissions are prerequisites for integrated authentication. To use SQLite instead, select `Database__Provider=Sqlite`, clear an unrelated SQL Server connection string, and run the same migration/start commands in Development.

### If Angular shows “API unavailable”

`ECONNREFUSED 127.0.0.1:5088` in the Angular terminal means the proxy could not reach an API listener on port 5088. Keep the Angular terminal running, then start the backend in a second terminal from the repository root. After configuring your database connection as above:

```powershell
$env:ASPNETCORE_ENVIRONMENT = 'Development'
dotnet run --project backend/Dadus.Api --launch-profile Dadus.Api -- --migrate
dotnet run --project backend/Dadus.Api --launch-profile Dadus.Api
```

The backend terminal must report port 5088 and stay open. If migrations fail, address that database error before trying the server command. To check the API from another PowerShell window:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:5088/api/health'
```

An HTTP 503 response is a different setup failure: its safe `detail`/`code` identifies missing provider configuration or unavailable database/schema. The client shows recovery guidance for recognized readiness codes. Check `ConnectionStrings__Dadus` and apply migrations for a storage error; configure the server key for `key_missing`, or explicitly select `Chat__Mode=Demo` in Development to test without live model access. The application does not automatically source `.env.example`.

When using `--no-launch-profile`, explicitly supply `--urls http://127.0.0.1:5088` or set `ASPNETCORE_URLS` as in the complete Windows sequence above. That option skips the profile's Development/port settings.

## API and design

`GET /api/health` verifies the storage schema and reports `demo` or `openai`. Chat endpoints require an anonymous GUID in `X-Dadus-Session`:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/agents` | List supported C# agents and tools. |
| POST | `/api/chat/message` | Send `{conversationId?, message, agentId?, language?}` and save a completed exchange. The default agent is `companion`; `language` accepts `auto` (default), `en`, `hi`, `mr`. The response includes the normalized language, `agentId` and tool summaries. |
| GET | `/api/chat/conversations` | List the current anonymous session's conversations. |
| GET | `/api/chat/history` | Read a bounded page using `conversationId`, optional `before`, and `limit`. |

Message input is capped at 4,000 characters. Provider context is bounded, and chat requests are rate limited. A failed provider call does not persist a partial exchange. Session identifiers are local bearer-like tokens, not authenticated accounts; this is not a production security boundary.

See [requirements](docs/requirements.md) and [architecture](docs/architecture.md). SQL Server schema changes use `dotnet ef migrations add <Name> --project backend/Dadus.Api`. Run SQL migrations explicitly with the API's `--migrate` command before startup; ordinary requests do not modify schema.
