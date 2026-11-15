# makefun-git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/afrzh11/makefun-git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/afrzh11/makefun-git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge written from scratch in TypeScript (Node 22 standard library only): git smart HTTP, REST v3, GraphQL v4 and MCP served from one deterministic in-memory store. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=00whd2w5&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git`: upload-pack protocol v2
  (ls-refs, fetch, shallow clones) and receive-pack v0 (pushes with
  fast-forward enforcement, report-status). The git object model, packfile
  reader/writer (OFS_DELTA / REF_DELTA, zlib) and pkt-line codec are all
  implemented in-process.
- **REST v3** under `/api/v3`: repositories, issues, pull requests, labels,
  comments, contents and users — the shapes the `gh` CLI sends.
- **GraphQL v4** at `/api/graphql`: a lexer, recursive-descent parser and
  executor over the repository/issue/pull-request types, including
  introspection (`__type`, `SearchType`), cursor pagination, Relay node ids
  and the create/close/merge mutations.
- **MCP** at `/mcp`: JSON-RPC 2.0 over Streamable HTTP (revision 2026-07-28,
  with a legacy `initialize` fallback) exposing `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request` and
  `merge_pull_request`.

All four surfaces share one deterministic in-memory store. Every timestamp
the server emits is a fixed epoch, so two runs on the same instance export
identical state.

## Layout

| File | Contents |
| --- | --- |
| `main.ts` | Lifecycle: bind an ephemeral port, register it with the suite, poll `/done`, exit. |
| `app.ts` | The HTTP server: routing for healthz, REST, GraphQL, MCP and git smart HTTP. |
| `store.ts` | The shared store: repos, objects, refs, issues, pulls, labels; the git object model (SHA-1, trees, commits, tags, merge-base, three-way squash merge, deterministic export). |
| `gitproto.ts` | pkt-line codec, packfile read/write, upload-pack v2, receive-pack v0, fetch object selection, push application. |
| `rest.ts` | REST v3 handlers. |
| `graphql.ts` | GraphQL lexer, parser and executor. |
| `mcp.ts` | MCP JSON-RPC handler and the six tools. |

## Run locally

`main.ts` reads `MAKEFUN_ENV_URL` (the suite endpoint to register with and
poll for `/done`) and `MAKEFUN_SHOP_TOKEN` (the bearer token every API call
must carry). Without `MAKEFUN_ENV_URL` it binds an ephemeral port and serves
until stopped, which is enough for manual curl checks:

```sh
curl -s http://localhost:$PORT/healthz
curl -s -H "Authorization: Bearer $MAKEFUN_SHOP_TOKEN" http://localhost:$PORT/api/v3/user
```

## How it was built

Every line is original work for this competition, written from the
competition kit's specification files (`checks-*.ts`, the suite's own clients,
`calibration.json`, the starter templates). No existing forge or git
implementation was copied.
