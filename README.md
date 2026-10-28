# DADUS AI

A local text-chat and AI-agent starter for DADUS AI: Angular UI, ASP.NET Core 8 / C# agents, EF Core 8 and SQL Server. The interface supports Unicode text in Marathi, Hindi, English and mixed language. Replies and tool summaries are escaped plain text.

Development starts in **Demo** mode. Demo replies are deterministic, visibly labelled, and do not call an AI model. OpenAI replies require a server-side key. This starter is for local development: anonymous browser sessions are separated, but account authentication is required before deployment. Voice, wake-word recognition, personal memory, reminders and mobile clients are later milestones.

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

## Enable real OpenAI replies

Configure `DadusOpenAI__ApiKey` securely in environment settings or the server process, allow HTTPS to `api.openai.com`, set `Chat__Mode=OpenAI`, and restart the API. `DadusOpenAI__Model` defaults to `gpt-4o-mini`; model availability depends on the account. The server uses the Chat Completions endpoint and disables response storage through `store=false`. This does not promise zero provider retention; check the provider's applicable data policy.

Never place the permanent API key in Angular, Git or chat messages. The application does not automatically load `.env`; `.env.example` only documents variable names. The cloud draft declares an optional personal key requirement targeting the custom server variable `DadusOpenAI__ApiKey`. `OPENAI_API_KEY` is reserved by the cloud platform, so this app uses the custom name.

No key is needed for Demo mode. The API reports missing live configuration as HTTP 503 and does not silently substitute a demo answer.

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
| POST | `/api/chat/message` | Send `{conversationId?, message, agentId?}` and save a completed exchange. The default agent is `companion`; the response includes `agentId` and tool summaries. |
| GET | `/api/chat/conversations` | List the current anonymous session's conversations. |
| GET | `/api/chat/history` | Read a bounded page using `conversationId`, optional `before`, and `limit`. |

Message input is capped at 4,000 characters. Provider context is bounded, and chat requests are rate limited. A failed provider call does not persist a partial exchange. Session identifiers are local bearer-like tokens, not authenticated accounts; this is not a production security boundary.

See [requirements](docs/requirements.md) and [architecture](docs/architecture.md). SQL Server schema changes use `dotnet ef migrations add <Name> --project backend/Dadus.Api`. Run SQL migrations explicitly with the API's `--migrate` command before startup; ordinary requests do not modify schema.
