# Lead Import Review

A small CRM workflow for checking and importing a CSV of leads. The React interface previews each row before saving. The Node API stores eligible rows in SQLite and reports duplicates and invalid rows with reasons.

I built this portfolio demo with AI-assisted implementation and used Concord MCP to replay the handoff from implementation to review. The included CSV uses fictional names and reserved `example.com` addresses.

## Run locally

Use Node.js 22.13 or later in the Node 22 line, or Node.js 24, plus npm and Git.

```sh
npm ci --ignore-scripts
npm run build
npm start
```

Open [Lead Import Review](http://127.0.0.1:4173). Keep the example loaded, click **Preview import**, then click **Save eligible leads**. With a fresh database, the preview shows two eligible leads, one duplicate and one invalid row. A second preview marks the two saved addresses as duplicates.

## Import behavior

Use UTF-8 CSV with the `name`, `email`, and `source` headers in any order. Quoted fields are supported. Each request can contain up to 500 data rows and 256 KiB.

| Request | Behavior |
| --- | --- |
| `GET /api/leads` | List saved leads in insertion order |
| `POST /api/import/preview` | Return row statuses and reasons without writing |
| `POST /api/import/commit` | Recheck the submitted CSV and save eligible rows |

Send the CSV request body as `text/csv`. The commit computes eligibility again inside a SQLite write transaction because another import could have occurred after preview. A unique constraint on normalized email protects retries and concurrent writes. By default, the SQLite file is stored in `.data/leads.sqlite`.

## Concord MCP

```sh
npm test
npm run concord:demo
```

`npm run concord:demo` runs the application tests and connects two scripted stdio clients to the pinned Concord MCP server in a temporary Git repository. It verifies that two tasks claiming the same file trigger a warning, that the builder retains ownership before the handoff is accepted, and that the reviewer can close the task with test evidence.

The demo uses synthetic task records in a temporary Concord profile. See the [recorded run](docs/concord-run.md) and [Concord MCP v0.23.0](https://github.com/Get-Concord-AI/concord-mcp/releases/tag/v0.23.0).

The app is designed for a single local user and binds to loopback. It has no user accounts or production CRM integrations.
