---
name: claude-config-tune
description: Lint and tune Claude Code configuration — deterministic hygiene checks for .claude permission allow-lists (superseded globs, redundant MCP enumerations, sensitive-server wildcards, missing dangerous-command denies, cross-project drift) plus an advisory, measured method for trimming CLAUDE.md context cost. Use when allow-lists feel bloated, approval prompts feel repetitive, or CLAUDE.md has grown past its usefulness.
---

# claude-config-tune

Keep `.claude/settings.local.json` permission lists and `CLAUDE.md` lean. Two
modes — run whichever the user asks for; default to **lint** if unspecified.

The token framing matters and is worth stating to the user:

- **CLAUDE.md is injected into context every session** — trimming it is
  *recurring* token savings. Real, but judgment-heavy.
- **The allow-list is config, NOT in the context window** — cleaning it saves
  *interaction friction* (fewer approval prompts, less re-explaining), not
  context tokens. Still worth it, just for a different reason.

## Mode 1 — lint (deterministic)

Run the linter against one or more project dirs (or settings files). It only
REPORTS — it never edits.

```bash
node <skill-dir>/lint.mjs <project-dir-or-settings.json>...
```

Pass 2+ projects to also run the cross-project drift check. Add `--ci` to
exit non-zero on a DEFINITE issue (superseded / redundant); advisory findings
never fail. Add `--config tune.json` to extend the defaults with your own
site-specific patterns, sensitive servers, and dangerous-command guards (see
the header of `lint.mjs` for the schema).

What it flags:

- **superseded** — a narrow `Bash(...)` already covered by a broader
  `Bash(X *)` glob → delete the narrow one.
- **redundant** — an enumerated `mcp__server__tool` already covered by a
  `mcp__server__*` wildcard → delete it.
- **consolidate** — 2+ enumerated tools on one server with no wildcard →
  replace with `mcp__server__*`. **Exception:** servers matching the
  sensitive list (send/delete/payment-shaped tools — gmail, slack, stripe,
  composio, …) are never consolidation candidates; a wildcard there
  auto-approves outward actions and any tool the server adds later.
- **sensitive-\*** — an *existing* wildcard on a sensitive server, flagged
  advisory with enumeration as the suggested fix.
- **one-off?** — a non-glob Bash entry that looks single-use (a path,
  `sed -n`, a long quoted literal). **Advisory** — confirm with the user it
  won't recur before removing.
- **push-guard** — a broad dangerous glob (default: `Bash(git *)`) with no
  deny shadowing its dangerous subcommand (`git push`).
- **drift** — allow/deny entries present in some projects but not all,
  excluding configured site-specific patterns.

After reporting, **propose** the concrete edits and let the user approve
before touching any file. Apply the removals/wildcards/denies, then re-run
the linter to confirm clean.

## Mode 2 — review (advisory, judgment-heavy)

CLAUDE.md prose tune-up. **Not automated** — verbosity in these files is
often hard-won lessons that only *look* trimmable. Surface candidate cuts as
a report; the user approves each one; never auto-edit.

**Trim heuristics**, in descending order of yield:

- **Relocate, don't delete** — the highest-yield move: relocate history and
  backstory to an on-demand sibling file (e.g. `changelog-archive.md`) and
  leave a one-line pointer ("read that for the story; read this every
  session for the rules"). Content survives; the every-session cost doesn't.
  Keep the main file current-state-only, with new history appending to the
  archive.
- **Backstory vs. rule** — keep the actionable rule, cut the narrative of
  how it was learned. If the *why* is load-bearing (prevents the model
  re-trying a bad path), compress it to one clause with an archive pointer.
- **Duplicated warnings** — the same caution in two sections; keep the one
  nearest where it applies.
- **War-story parentheticals** — "(this happened when…)" asides that don't
  change model behavior.
- **Derivable content** — anything the model can read from the repo itself
  (file structure, command output) shouldn't be prose.
- **Dead references** — rules about files, tools, or workflows that no
  longer exist.

**Measure the win:** count tokens before and after — exact via the
`count_tokens` API, or words × 1.33 labeled as an estimate. Report it as
"N → M tokens per session" (recurring savings), not a percentage feeling.

**Verify the trim:** record the trim date in the tuned file. Over the
following sessions, watch for the model violating a trimmed rule — one
violation means the rule was load-bearing; restore it immediately rather
than debating. "No degradation" is a claim that needs this watch period
behind it.

**Multi-project harmonization:** where several projects share a config
template, their CLAUDE.md files should differ only on intended deltas.
Report any other divergence; apply approved trims to all of them in
lockstep.
