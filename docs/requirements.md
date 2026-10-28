# DADUS AI: first development milestone

This repository starts the web MVP described in the supplied DADUS AI handoff. The initial milestone is an Angular text-chat interface backed by ASP.NET Core 8, EF Core 8 and SQL Server. This is a local development application.

## Included

- Responsive DADUS AI branding and a text composer supporting Marathi, Hindi, English and mixed text.
- A clearly labelled development demo responder, plus a server-side OpenAI integration selected through configuration.
- Conversation creation, persisted message pairs, conversation switching and paginated history.
- Anonymous browser-session separation for local development, input limits, structured error responses and rate limits.
- Explicit database migrations, pinned tools, lockfiles, automated tests and repeatable cloud startup instructions.
- An explicit SQLite Development-only fallback so the local demo can run if the SQL Server image is unavailable; SQL Server remains the default and must be validated separately.
- C# Companion, Planner and Coding agents selected from the Angular UI, with a bounded live tool-calling loop and local calculator/time tools. Demo commands are visibly distinguished from live model-selected tool use.
- Browser microphone dictation into a reviewed draft, selectable Marathi/Hindi/English language, and optional spoken replies using available browser/system voices. Unsupported browsers and missing voices show recovery guidance; voice recognition never sends automatically.
- Safe provider error codes that distinguish rejected credentials, project access, API quota, rate limits and unavailable models without exposing provider response bodies.

## Acceptance checks

1. The Angular production build and component/service tests pass.
2. The .NET solution builds and its unit/integration tests pass.
3. SQL Server answers a real query and EF migrations can run twice without data loss.
4. A demo chat request persists both messages, a history request returns them, and a different browser session cannot access them.
5. Missing live-provider configuration produces a clear error; failed provider calls do not leave a partial message pair.
6. Demo mode is visible in the UI and API responses. It must never be described as a live AI response.
7. Agent selection reaches the backend, unsupported agents are rejected, real local tool results are shown as escaped text, and a mocked live model can call a tool and consume its result before answering.
8. Browser API mocks verify dictation, cancellation, explicit send, reading opt-in and unsupported/error paths. Real microphone and speech output are device-dependent and need manual validation.

## Later milestones

Real authentication and authorized account ownership are required before deployment. The anonymous session header used here is not an identity system. Personal memory, reminders, exports/deletion controls, production abuse controls, authentication, real-time voice, browser wake-word prototypes and Ionic/Capacitor mobile clients remain separate increments.

Do not claim reliable wake recognition, Marathi speech output, background listening or live OpenAI behavior from mocked development tests. Microphone permission is requested only after the user activates dictation; automatic reply reading is off until enabled.
