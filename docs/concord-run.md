# Concord MCP run

Verified on Windows with Node.js 24.22.3 and Concord MCP 0.23.0.

- Six application tests passed, including an HTTP import retry and a commit after the database changed.
- A second task claimed `src/lead-import.js`. Concord returned an overlap warning.
- The builder offered the import task to the reviewer. The task stayed owned by the builder while the offer was pending.
- The reviewer accepted, became the owner, and completed the task with the changed paths and passing test command.

Run `npm run concord:demo` to reproduce the checks. The two identities are scripted stdio clients. The replay starts an empty temporary Git workspace and keeps its Concord state locally with telemetry disabled.
