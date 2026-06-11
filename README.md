# flowdiff

**Call-graph diffs for code review.** Line diffs answer "what characters changed." Review is actually the question "what *behavior* changed." flowdiff shows the structural delta of a change — which functions appeared, disappeared, or changed, and how the call flow was rewired — right in your terminal.

This matters more than ever now that much of the code in a diff was written by an AI agent. Whoever operated the agent still has to comprehend and approve the result, and a flat list of line diffs in alphabetical file order is the wrong tool for that. Existing code-graph tools (code-review-graph, Greptile, etc.) build exactly this graph — and then feed it to the AI as context. flowdiff renders it for the human.

```
flowdiff HEAD → worktree

  functions   +4  −1  ~2      call edges  +6  −1

src/jobs.ts
  + retryFailedRefunds :3
    callers  none found (entry point?)
    calls    +processRefund:4 (src/payments.ts)

src/payments.ts
  + assessRisk :22
    callers  +processRefund:4
    calls    +flagForReview:28

  ~ processRefund :4
    callers  +retryFailedRefunds:3 (src/jobs.ts)  handleWebhook:3 (src/server.ts)
    calls    loadOrder:14  validateAmount:18  +assessRisk:22  +auditLog*  +withRetry:32  refund*  −legacyCheck:20

  − legacyCheck :20
    callers  processRefund:3
```

One glance tells you the review story: there's a new entry point, `processRefund` gained a risk check, audit logging, and a retry wrapper, lost the legacy fraud heuristic, and is now reachable from a background job. That's the part of review you previously reconstructed in your head, one file at a time.

## Usage

```sh
flowdiff                    # HEAD vs working tree — run it right after your agent edits
flowdiff main               # main vs working tree
flowdiff main..feature      # any two revisions
flowdiff fn processRefund   # before/after diff of one function
flowdiff --json             # structured output — scripts, or context for an AI reviewer
```

Run it from anywhere inside a git repo. `+` added, `−` removed, `~` body changed, `→` renamed/moved, `*` callee not defined in this repo.

## Install

```sh
npm install && npm run build && npm link
```

Node ≥ 18. The only runtime dependency is the TypeScript compiler, which is also the parser.

## How it works

1. Lists `.ts`/`.tsx`/`.js`/`.jsx` files at both revisions (`git ls-tree` / working tree).
2. Parses every file with the TypeScript compiler API and extracts named functions, methods, and arrow-function bindings, plus every call made inside them (calls inside anonymous closures attribute to the nearest enclosing named function; calls to a function's own parameters are skipped as callback invocations).
3. Builds a call graph per revision. Call sites resolve by name, preferring same-file definitions; unresolved callees become external nodes, with a noise filter for `map`/`push`/`then`-style builtins.
4. Diffs the two graphs — functions by `file#name` identity with body-hash change detection, edges by endpoint pair — and renders the delta grouped by file.
5. Detects renames and moves: a removed and an added function whose *name-blinded* bodies hash identically (and match no other candidate) are reported as `→ old → new`, and edges are compared through the rename so the surrounding graph doesn't show phantom churn.

Name-based call resolution is a deliberate v0 heuristic: it's wrong in the ways dynamic dispatch is wrong, and right often enough to tell the review story.

## Not yet

- Branch-level deltas (new `if`/`switch` arms inside a changed function)
- Rename detection for *edited* renames (exact-body renames are detected; renamed-and-changed still shows as remove + add)
- Other languages (the extractor is one ~100-line file; tree-sitter would generalize it)
- Interactive TUI navigation (arrow keys through the graph, expanding diffs inline)
- A GitHub Action that posts the flow summary as a PR comment
