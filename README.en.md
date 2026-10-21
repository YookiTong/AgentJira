# Agent Jira

[中文说明](README.md)

A local project workspace for an AI team. Describe a goal, refine the brief with your project lead, and approve it. The lead then designs a team and execution plan, assigns independent modules, reviews actual files, and brings the work together at integration nodes. A module is one executable task.

## Run locally

Requires Node.js **22.16+**, Git, and an authenticated local Codex installation.

```sh
npm ci
npm run build
npm start
```

Open [Agent Jira in English](http://127.0.0.1:4310/?lang=en) or [中文工作台](http://127.0.0.1:4310/?lang=zh-CN). The server only listens on loopback. Closing the browser does not stop work; stopping the service interrupts runs and preserves their history.

Use **Settings & models** to select the Codex executable, default model, concurrency, rework limit, and phase limit. The default is three concurrent member tasks, two revisions per task, and eight phases. Codex credentials remain on the server. The existing `HELIU_PORT`, `HELIU_DATA_DIR`, `HELIU_URL`, and `CODEX_BIN` environment variables remain supported for compatibility.

## Workspace

The sidebar is the project switcher. Every project shows its name, objective summary, and status. The top navigation contains only the selected project’s pages: **Requirements, Execution plan, Workflow, Task board, Team board, Deliverables, and Activity**. Selected pages, chat drafts, and graph positions remain independent and survive refresh, including migration from earlier tab-based caches. On narrow screens, open the full list with **Projects**.

The main content scrolls as one document. Boards can scroll horizontally. Scroll normally over the workflow to move down the page; use the canvas controls or a pinch gesture to zoom. The conversation scrolls independently without pulling the document down when messages arrive.

1. Enter a goal. Optionally attach source files, select a working directory, or import a local Codex conversation.
2. Review the structured requirements. Resolve open questions, edit the brief, and select **Approve & create plan**. Member tasks cannot run before approval.
3. The lead designs a project-specific team and plan. Research modules can include hypotheses, variables, controls, experimental setup, and evaluation metrics.
4. Follow the same modules in the workflow, three-column task board, or role-based team board. Open any module to inspect its method, inputs, acceptance criteria, execution history, and actual files.
5. Integration waits for every required upstream result to pass review. Failed reviews trigger a new execution attempt while dependent modules wait. History is preserved.
6. Use **Conversation** to discuss the project and **Updates** to review progress. Asking for status does not change the plan. A scope change pauses the project and creates a new brief for approval. A module-specific prompt reruns that module and revalidates downstream work.

The task board has **Ready to start → In progress → Completed** columns. Blocked and interrupted modules remain in the first column with an explanation; review is in progress; only accepted results are completed. Team board columns group people with the same role. Leads and members have editable names. Task priority is an integer **0–10**, with 10 highest, and only affects tasks whose dependencies are satisfied.

## Languages

Switch between English and Simplified Chinese in the header. Both versions use the same components and execution logic, including dialogs, validation, empty states, and accessibility labels. The selected language is saved locally and included in project URLs.

New projects store their language. The lead produces requirements, names, plans, reviews, and summaries in that language unless the user explicitly requests another deliverable language. Switching the interface does not rewrite existing project content, files, names, or conversation history. Legacy projects default to Chinese.

## Reliability and integrations

- A deterministic scheduler validates member references, missing dependencies, cycles, and occupied runs. Model suggestions do not bypass service validation.
- Requirement approval is versioned and idempotent. Start, resume, retries, and plan imports cannot bypass it.
- Every module has an independent session, execution record, and workspace. Accepted deliverables are verified on disk and stored as snapshots.
- Software projects use independent Git worktrees and a dedicated integration branch. Uncommitted source changes are not overwritten, and no remote push or publication happens automatically.
- Pause stops dispatch and interrupts current runs. On service restart, unconfirmed runs remain interrupted for explicit continuation rather than being duplicated or reported as complete.
- Active projects use SSE; background project statuses refresh every ten seconds. Connection failures are visible and reconnect automatically.
- The service validates request origins and hosts, limits attachments to 10 MB, rejects paths escaping project storage, and renders model Markdown without executing HTML.

The backend uses Node.js, Fastify, SQLite, and a provider-independent `AgentBackend` interface. The production adapter connects to **Codex app-server over stdio JSON-RPC**. A future vLLM adapter must supply inference plus a tool-execution loop. vLLM, multiple users, and remote hosting are not implemented in this version.

## API

[English OpenAPI description](http://127.0.0.1:4310/api/openapi.json?lang=en)

Create a project:

```json
{
  "goal": "Create and review a short product guide",
  "language": "en",
  "start": true
}
```

Send this body to `POST /api/projects`. An optional `Idempotency-Key` prevents duplicate creation. `start:true` starts requirement discovery only. Read the latest requirement version, then submit `{ "version": 1 }` to `POST /api/projects/:id/requirements/confirm` to approve it and begin planning. Omitted language defaults from `Accept-Language`, then Chinese.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/projects` | List project snapshots |
| `GET /api/projects/:id` | Read a project, tasks, runs, and files |
| `PUT /api/projects/:id/requirements` | Save a versioned brief |
| `POST /api/projects/:id/messages` | Send context to the lead; optional `taskId` targets a module |
| `POST /api/projects/:id/control` | Start, pause, or resume |
| `PATCH /api/projects/:id/tasks/:taskId` | Change a pending module's owner, priority, or dependencies |
| `PATCH /api/projects/:id/supervisor` | Rename the project lead |
| `PATCH /api/projects/:id/members/:memberId` | Edit a member's name, role, instructions, or model |
| `GET /api/projects/:id/events` | SSE snapshots and updates |
| `GET /api/projects/:id/plan` | Export plan JSON |
| `PUT /api/projects/:id/plan` | Import a plan after approval while paused |
| `POST /api/projects/:id/attachments` | Attach source material |
| `GET /api/projects/:id/artifacts/:artifactId` | Download a registered file |

## Development and verification

```sh
# Separate terminals
npm run dev
npm run dev:web

npm run check
npm test
npm run build

# Real Codex integration; creates a small project and uses model quota
HELIU_LANGUAGE=en npm run smoke:codex
```

Automated tests use temporary storage and a test adapter. They cover scheduling, parallelism, joins, rework, file validation, duplicate dispatch, multiple-project limits, pause/recovery, Git integration, requirements and approval, versioned plans, API origin validation, project navigation state, role grouping, priority migration, naming, and bilingual workflows.

The real smoke project verifies that no member executes before approval, two modules actually overlap in time, an integration module reads their files, all results are reviewed, and the final files can be downloaded. Evidence is written to `.cache/codex-smoke-en.json`. A timeout pauses the project and preserves its records.

Project data lives in `.data/`. Stop the service before backing up the entire directory so SQLite and workspace files remain consistent. Legacy projects and outputs are preserved; their old 0–100 priorities migrate to 0–10 once, with the original snapshot retained in SQLite's `project_migrations` table.
