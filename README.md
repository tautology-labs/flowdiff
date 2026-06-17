# flowdiff

**Call-graph diffs for code review.** Line diffs answer "what characters changed." Review is actually the question "what *behavior* changed." flowdiff shows the structural delta of a change — which functions appeared, disappeared, or changed, and how the call flow was rewired — right in your terminal.

This matters more than ever now that much of the code in a diff was written by an AI agent. Whoever operated the agent still has to comprehend and approve the result, and a flat list of line diffs in alphabetical file order is the wrong tool for that. Existing code-graph tools (code-review-graph, Greptile, etc.) build exactly this graph — and then feed it to the AI as context. flowdiff renders it for the human.

```
flowdiff HEAD → worktree

  functions   +4  −1  ~2  →0      call edges  +6  −1
  + added   − removed   ~ body changed   → renamed/moved

src/jobs.ts

  + retryFailedRefunds :3
    callers   none found (entry point?)
    calls     +processRefund:4 (src/payments.ts)

src/payments.ts

  + assessRisk :22
    callers   +processRefund:4
    calls     +flagForReview:28

  ~ processRefund :4
    callers   +retryFailedRefunds:3 (src/jobs.ts)  handleWebhook:3 (src/server.ts)
    calls     loadOrder:14  validateAmount:18  +assessRisk:22  +withRetry:32  −legacyCheck:20
    external  +auditLog  refund

  − legacyCheck :20
    callers   processRefund:3
```

One glance tells you the review story: there's a new entry point, `processRefund` gained a risk check, audit logging, and a retry wrapper, lost the legacy fraud heuristic, and is now reachable from a background job. That's the part of review you previously reconstructed in your head, one file at a time.

## Usage

```sh
flowdiff                    # HEAD vs working tree — run it right after your agent edits
flowdiff main               # main vs working tree
flowdiff main..feature      # any two revisions
flowdiff fn processRefund   # before/after diff of one function
flowdiff blast handleRefund v1.42.0 v1.43.0
                            # incident mode: which changed functions can touch
                            # the symptom? call paths included
flowdiff -i                 # interactive: navigate the graph, → browses callers,
                            # enter expands diffs, e opens $EDITOR
flowdiff --html > review.html   # self-contained interactive graph (no CDN, opens
                            # offline, attach to a PR); bare --html writes a file
flowdiff roots              # locally-linked sibling services in the graph
flowdiff --json             # structured output — scripts, or context for an AI reviewer
```

Tab completion (subcommands, git refs, and live function names from the parsed graph) — add to `~/.zshrc`:

```sh
eval "$(flowdiff completions zsh)"
```

Unknown function names get did-you-mean suggestions; ambiguous ones (Java overloads, duplicates) list candidate `file#name` ids to pick from.

Interactive mode (`-i`) turns the cards into a browser: `↑`/`↓` move between functions, `enter` expands a function's diff inline, `tab` picks a caller/callee to jump to, and `e` opens `$EDITOR` at that exact function — when you return, the working tree is re-scanned and the graph diff updates around your edit. Press `?` for keys and the marker legend. The edit-while-seeing-callers loop is a deliberate revival of the Smalltalk System Browser (1980), which treated the function-in-its-graph, not the file, as the unit of editing.

Run it from anywhere inside a git repo. `+` added, `−` removed, `~` body changed, `→` renamed/moved. The `calls` row is flow within your repo; the `external` row is calls that leave it (imports, stdlib) — a `+` there means the change took on a new outside dependency.

## Install

```sh
npm install && npm run build && npm link
```

Node ≥ 18. Two runtime dependencies, both pure JS, both parsers — no native modules. Adding a language means writing one extractor file answering "what's a function, what does it call"; everything else — graph, diff, rename detection, TUI, MCP tools — is language-agnostic.

## Languages

| language | parser | extracted | honest caveats |
|---|---|---|---|
| TypeScript / JavaScript (`.tsx`/`.jsx`/`.mjs`/`.cjs` too) | the TypeScript compiler | functions, methods, arrow/function-expression consts, constructors, accessors; calls inside closures attribute to the enclosing named function | call resolution is name-based (same-file preferred) — wrong in the ways dynamic dispatch is wrong |
| Java | `java-parser` (Chevrotain, pure JS) | methods and constructors as `Class.method` / `Class.constructor`, incl. nested types, fluent/static/`this.` call chains | overloads share a name → bare-name queries list candidate ids; anonymous-class calls attribute to the anonymous member |
| Python | built-in extractor (strings/comments blanked, bracket-aware indent scoping) | `def`/`async def`, methods as `Class.method`, decorators included in source and line | dynamic dispatch (`getattr`, exec) invisible to any static graph; untyped attribute calls resolve noisier than TS/Java; tree-sitter-WASM is the upgrade path |
| Jupyter (`.ipynb`) | code cells → Python extractor | same as Python | magics/`!shell` lines skipped; line numbers refer to concatenated cells, not cell positions |

## MCP — give the graph to your agent

*GraphQL, for code, for those who read code one hop at a time.*

The same graph, served as tools. Frontier models lose the thread following logic across a call stack because they read *files* while a call stack is a *graph* — these tools let an agent traverse function-by-function instead:

```sh
# Claude Code
claude mcp add flowdiff -- node /absolute/path/to/flowdiff/dist/mcp.js
```

```toml
# Codex (~/.codex/config.toml — key names may shift across versions, check their docs)
[mcp_servers.flowdiff]
command = "node"
args = ["/absolute/path/to/flowdiff/dist/mcp.js"]
```

MCP is an open protocol, so any MCP client works the same way — Cursor, Windsurf, your own agent: point it at `node dist/mcp.js` over stdio. The server reads the repo it's launched in (or `CLAUDE_PROJECT_DIR` when set).

| tool | what the agent gets |
|---|---|
| `find_functions` | search by name; `entry_points_only` lists where execution starts |
| `function_info` | one function's source + callers + callees + external calls |
| `flow_diff` | the structural delta between two revisions |
| `function_diff` | one function's before/after line diff |

"Explain this unfamiliar repo" becomes: `find_functions(entry_points_only)` → `function_info` hop by hop — never reading a file that isn't on the path. "Review this change" becomes: `flow_diff` → `function_diff` on whatever looks scary. The server is hand-rolled newline-delimited JSON-RPC over stdio — still zero dependencies. Commit graphs are cached; the working tree is re-parsed per call so the agent always sees your latest edit.

### Across services

The working-tree graph spans **locally-linked sibling services**, not just one repo. When you have several services checked out side by side and linked (a `file:`/`workspace:` dependency, or an `npm link` / `file:` install that leaves a symlink in `node_modules`), `function_info` resolves callers and callees *across* the service boundary. So before you change a shared contract, one `function_info` on it lists every consumer in every linked service — the case where reading files one at a time loses track and updates 3 of 5 callers. Run `flowdiff roots` to see what's stitched together. Registry dependencies are never followed, so this doesn't drag in `node_modules`.

```sh
npm test   # 20 unit tests, node:test, no test framework
```

## How it works

1. Lists `.ts`/`.tsx`/`.js`/`.jsx` files at both revisions (`git ls-tree` / working tree).
2. Parses every file with the TypeScript compiler API and extracts named functions, methods, and arrow-function bindings, plus every call made inside them (calls inside anonymous closures attribute to the nearest enclosing named function; calls to a function's own parameters are skipped as callback invocations).
3. Builds a call graph per revision. Call sites resolve by name, preferring same-file definitions; unresolved callees become external nodes, with a noise filter for `map`/`push`/`then`-style builtins.
4. Diffs the two graphs — functions by `file#name` identity with body-hash change detection, edges by endpoint pair — and renders the delta grouped by file.
5. Detects renames and moves: a removed and an added function whose *name-blinded* bodies hash identically (and match no other candidate) are reported as `→ old → new`, and edges are compared through the rename so the surrounding graph doesn't show phantom churn.

Name-based call resolution is a deliberate v0 heuristic: it's wrong in the ways dynamic dispatch is wrong, and right often enough to tell the review story.

## Not yet

- A GitHub Action that posts the flow summary (and the `--html` artifact) as a PR comment
- Branch-level deltas (new `if`/`switch` arms inside a changed function)
- Rename detection for *edited* renames (exact-body renames and moves are detected; renamed-and-changed still shows as remove + add)
- Go and friends (one extractor file each); production-grade Python via tree-sitter-WASM
- Java overload merging (one logical function instead of suffixed candidates)
- Cross-repo *historical* diff (multi-root spans working trees; commit-pair diffs stay single-repo)
- Docs drift: the graph knows which functions a diff renamed or removed — intersect with the names your README/docs still mention, and stale documentation becomes a diff-time warning instead of a slow embarrassment
- Differential tracing: run the test suite at both revisions under instrumentation and diff the *runtime* call patterns — catch the change that makes an input loop forever or allocate unboundedly
