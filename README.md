# claude-config-tune

A Claude Code skill for configuration hygiene: a deterministic, report-only
**linter for permission allow-lists**, and a measured, verified **method for
trimming CLAUDE.md** context cost.

## Two problems, two different economics

Claude Code configuration bloats in two places, and they cost you differently:

- **`CLAUDE.md` is injected into context every session.** Every stale rule,
  duplicated warning, and war-story paragraph is a tax on *every session
  forever*. Trimming it is recurring savings.
- **The permission allow-list is config, not context.** Bloat there costs
  *friction* — approval prompts for things a glob already covers, drift
  between projects that should match — not tokens. Different problem, still
  worth fixing.

Most token-optimization advice conflates these. This skill treats them as
what they are: a mechanical lint problem and a judgment-heavy editing
problem, handled by different modes with different trust models.

## Mode 1 — the linter (deterministic, report-only)

```bash
node skills/claude-config-tune/lint.mjs <project-dir>...
```

Zero dependencies, never edits, CI-able (`--ci` fails only on *definite*
issues, never advisory ones). What it flags:

| Finding | Meaning |
|---|---|
| `superseded` | A narrow `Bash(...)` entry already covered by a broader `Bash(X *)` glob |
| `redundant` | An enumerated `mcp__server__tool` already covered by that server's `*` wildcard |
| `consolidate` | 2+ enumerated tools on one server → suggest the wildcard |
| `sensitive-*` | A wildcard on a **sensitive server** (gmail, slack, stripe, composio, …) — advisory: enumerate instead |
| `one-off?` | A Bash entry that looks single-use (advisory — confirm before removing) |
| `push-guard` | A broad dangerous glob (default `git *`) with no deny on its dangerous subcommand (`git push`) |
| `drift` | Entries present in some of your projects but not all |

**The sensitive-server guard is the part you won't find elsewhere.**
Consolidating `mcp__gmail__search` + `mcp__gmail__get_message` into
`mcp__gmail__*` looks like cleanup — but the wildcard silently auto-approves
`send_message`, and every tool that server adds later. Sensitive servers are
never consolidation candidates here, and an existing wildcard on one is
flagged with enumeration as the fix. Widening permissions is a security
decision, not a hygiene win; the linter knows the difference.

Extend the defaults (site-specific drift exclusions, your own sensitive
servers, additional dangerous-glob guards) via `--config tune.json` — schema
in the header of `lint.mjs`.

## Mode 2 — the CLAUDE.md review (advisory, measured, verified)

Not automated, on purpose: CLAUDE.md verbosity is often hard-won lessons
that only *look* trimmable. Instead, the skill gives the model a trim
method: six heuristics in descending order of yield (the big one:
**relocate history to an on-demand archive file, don't delete it**), a
measurement step (report "N → M tokens per session," not a percentage
feeling), and a verification protocol (date the trim, watch the following
sessions, restore any trimmed rule the model violates — once).

### Case study

Run against a production Claude project (the author's career-ops pipeline,
Claude + Google Drive): the always-loaded `CLAUDE.md` went from **~60KB to
~36KB** (~10.8k → ~6.5k tokens estimated) — a ~40% recurring cut — by
relocating session history to an on-demand `changelog-archive.md` with a
one-line pointer, keeping the main file current-state-only. Executed by
Claude Sonnet 5 at high effort using this skill; no rule violations
observed in the sessions since (trim dated 2026-07-19, watch ongoing).

## Token footprint

~175 tokens always-on (only the description loads until the skill fires) —
measured with `claude plugin details claude-config-tune`; re-run it yourself,
the numbers drift as the skill evolves. A config-hygiene skill that bloated
your config would be refuting itself.

## Install

As a plugin:

```
/plugin marketplace add dgaidula/claude-config-tune
/plugin install claude-config-tune
```

Or manually, as a personal skill:

```sh
git clone https://github.com/dgaidula/claude-config-tune
cp -r claude-config-tune/skills/claude-config-tune ~/.claude/skills/
```

The linter also works standalone — it's a single zero-dependency `.mjs` you
can run or wire into CI without installing the skill at all.

## Use

```
/claude-config-tune
```

…or describe the problem ("my allow-list is bloated", "trim this CLAUDE.md")
and let Claude load it. Lint is the default mode; ask for "review" for the
CLAUDE.md pass.

Pairs with [orchestrator-discipline](https://github.com/dgaidula/orchestrator-discipline)
— same philosophy applied to a different layer: run your AI tooling like
production infrastructure, with measured footprints, linted configs, and
disciplined delegation.

## License

MIT © Dan Gaidula
