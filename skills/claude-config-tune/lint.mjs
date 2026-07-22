#!/usr/bin/env node
/**
 * claude-config-tune lint — deterministic hygiene check for `.claude/settings.local.json`
 * permission lists (the "auto-approve" allow-list + deny-list).
 *
 * It does NOT edit anything. It reports actionable findings so a human (or a
 * follow-up model pass) can prune with confidence. This is the mechanical half
 * of a config tune-up; the CLAUDE.md prose review stays a judgment call (see
 * SKILL.md "review" mode).
 *
 * Usage:
 *   node lint.mjs <path>...                    # each path = a project dir or a settings json
 *   node lint.mjs --ci <path>...               # exit 1 on DEFINITE issues (superseded /
 *                                              # wildcard-redundant); advisory never fails CI
 *   node lint.mjs --config tune.json <path>... # extend defaults with your own patterns
 *
 * Config file (all keys optional, additive to defaults):
 *   {
 *     "siteSpecific":     ["regex", ...],   // entries EXPECTED to differ across projects
 *     "sensitiveServers": ["regex", ...],   // MCP servers never to wildcard-consolidate
 *     "pushGuards": [{ "glob": "git", "requireDenyPrefix": "git push", "why": "..." }]
 *   }
 *
 * Checks (per file):
 *   1. superseded   — a narrow Bash entry already covered by a broader `X *` glob
 *   2. mcp-wildcard — enumerated mcp tools that a `mcp__server__*` would cover
 *                     (or already does, making them redundant)
 *   3. sensitive    — servers with send/delete/payment-shaped tools are never
 *                     consolidation candidates; an existing wildcard there is
 *                     flagged advisory (enumeration is the fix)
 *   4. dead-one-off — a non-glob Bash entry that looks single-use — ADVISORY
 *   5. push-guard   — a broad glob allowed with no deny on its dangerous subcommand
 * Cross-file (>= 2 paths):
 *   6. drift        — entries present in some files but not all, excluding
 *                     site-specific patterns
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// --- defaults (extend via --config) -------------------------------------------

// Patterns EXPECTED to differ between harmonized projects; drift check ignores them.
const DEFAULT_SITE_SPECIFIC = [];

// Broad Bash globs whose power warrants a matching deny on a dangerous subcommand.
const DEFAULT_PUSH_GUARDS = [
  { glob: 'git', requireDenyPrefix: 'git push', why: 'a broad git glob auto-approves pushes; keep pushes behind an explicit prompt' },
];

// MCP servers with send/delete/payment-shaped tools. Consolidating these to a
// `mcp__server__*` wildcard would silently auto-approve outward or destructive
// actions (and any tool the server adds later).
const DEFAULT_SENSITIVE_SERVERS = [/gmail/, /google-workspace/, /composio/, /slack/, /stripe/, /twilio/, /sendgrid/, /mail/];

// --- CLI ----------------------------------------------------------------------

const argv = process.argv.slice(2);
const ci = argv.includes('--ci');
const configIdx = argv.indexOf('--config');
const configPath = configIdx !== -1 ? argv[configIdx + 1] : null;
const paths = argv.filter((a, i) => a !== '--ci' && a !== '--config' && (configIdx === -1 || i !== configIdx + 1));

if (paths.length === 0) {
  console.error('usage: node lint.mjs [--ci] [--config tune.json] <project-dir-or-settings.json>...');
  process.exit(2);
}

let SITE_SPECIFIC = [...DEFAULT_SITE_SPECIFIC];
let PUSH_GUARDS = [...DEFAULT_PUSH_GUARDS];
let SENSITIVE_SERVERS = [...DEFAULT_SENSITIVE_SERVERS];
if (configPath) {
  try {
    const cfg = JSON.parse(readFileSync(resolve(configPath), 'utf8'));
    for (const s of cfg.siteSpecific ?? []) SITE_SPECIFIC.push(new RegExp(s));
    for (const s of cfg.sensitiveServers ?? []) SENSITIVE_SERVERS.push(new RegExp(s));
    for (const g of cfg.pushGuards ?? []) PUSH_GUARDS.push(g);
  } catch (e) {
    console.error(`--config ${configPath}: ${e.message}`);
    process.exit(2);
  }
}

const C = process.stdout.isTTY
  ? { dim: (s) => `\x1b[2m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` }
  : { dim: (s) => s, red: (s) => s, yellow: (s) => s, green: (s) => s, bold: (s) => s };

/** Resolve a CLI path to its settings.local.json (accepts the file or its project dir). */
function resolveSettings(p) {
  const abs = resolve(p);
  if (abs.endsWith('.json')) return abs;
  return join(abs, '.claude', 'settings.local.json');
}

/** `Bash(<inner>)` -> inner, else null. */
function bashInner(entry) {
  const m = entry.match(/^Bash\((.*)\)$/s);
  return m ? m[1] : null;
}

/** If `inner` is a trailing-glob (`foo bar *`), return its literal prefix (`foo bar`), else null. */
function globPrefix(inner) {
  const m = inner.match(/^(.*?)\s*\*+$/s);
  if (!m) return null;
  return m[1].replace(/\s+$/, '');
}

/** Does glob prefix cover another command string? */
function covers(prefix, other) {
  return other === prefix || other.startsWith(prefix + ' ');
}

function looksOneOff(inner) {
  return (
    /\//.test(inner) || // a path
    /\b(sed -n|perl -pi|-pi -e|cp |mv |rm )\b/.test(inner) ||
    /"[^"]{15,}"/.test(inner) // a long quoted literal
  );
}

function isSiteSpecific(entry) {
  return SITE_SPECIFIC.some((re) => re.test(entry));
}

/** Parse an `mcp__server__tool` entry -> { server, tool } (tool may be '*'). */
function mcpParts(entry) {
  if (!entry.startsWith('mcp__')) return null;
  const parts = entry.split('__');
  if (parts.length < 3) return null;
  return { server: parts[1], tool: parts.slice(2).join('__') };
}

const reports = [];
let definiteIssues = 0;

for (const p of paths) {
  const file = resolveSettings(p);
  const findings = { file, superseded: [], mcpRedundant: [], mcpConsolidate: [], sensitiveWildcard: [], sensitiveKeep: [], deadOneOff: [], pushGuard: [], error: null };

  if (!existsSync(file)) {
    findings.error = 'no settings.local.json found';
    reports.push(findings);
    continue;
  }

  let json;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    findings.error = `invalid JSON: ${e.message}`;
    reports.push(findings);
    continue;
  }

  const allow = json?.permissions?.allow ?? [];
  const deny = json?.permissions?.deny ?? [];
  findings.allow = allow;
  findings.deny = deny;

  // --- 1. superseded Bash entries -------------------------------------------
  const bashEntries = allow.map((e) => ({ entry: e, inner: bashInner(e) })).filter((x) => x.inner !== null);
  const globs = bashEntries.map((x) => ({ ...x, prefix: globPrefix(x.inner) })).filter((x) => x.prefix !== null);

  for (const a of bashEntries) {
    const covering = globs.find((g) => g.entry !== a.entry && covers(g.prefix, a.inner));
    if (covering) {
      findings.superseded.push({ entry: a.entry, by: covering.entry });
    }
  }

  // --- 2 + 3. mcp wildcard opportunities, sensitive-server guard ------------
  const byServer = new Map();
  for (const e of allow) {
    const m = mcpParts(e);
    if (!m) continue;
    if (!byServer.has(m.server)) byServer.set(m.server, []);
    byServer.get(m.server).push({ entry: e, tool: m.tool });
  }
  for (const [server, tools] of byServer) {
    const hasWildcard = tools.some((t) => t.tool === '*');
    const specifics = tools.filter((t) => t.tool !== '*');
    const sensitive = SENSITIVE_SERVERS.some((re) => re.test(server));
    if (sensitive) {
      // Never suggest widening a sensitive server. An existing wildcard is
      // itself the finding (advisory) — enumerated entries are the fix, not
      // redundant, so skip the redundant check for this server.
      if (hasWildcard) findings.sensitiveWildcard.push({ server, entry: `mcp__${server}__*` });
      if (!hasWildcard && specifics.length >= 2) findings.sensitiveKeep.push({ server, count: specifics.length });
      continue;
    }
    if (hasWildcard && specifics.length) {
      for (const s of specifics) findings.mcpRedundant.push({ entry: s.entry, by: `mcp__${server}__*` });
    } else if (!hasWildcard && specifics.length >= 2) {
      findings.mcpConsolidate.push({ server, count: specifics.length, suggest: `mcp__${server}__*`, entries: specifics.map((s) => s.entry) });
    }
  }

  // --- 4. dead one-off candidates (advisory) --------------------------------
  for (const a of bashEntries) {
    if (a.prefix) continue; // skip globs
    const covered = globs.some((g) => g.entry !== a.entry && covers(g.prefix, a.inner));
    const supersededAlready = findings.superseded.some((s) => s.entry === a.entry);
    if (!covered && !supersededAlready && looksOneOff(a.inner)) {
      findings.deadOneOff.push({ entry: a.entry });
    }
  }

  // --- 5. push-guard --------------------------------------------------------
  for (const guard of PUSH_GUARDS) {
    const broad = globs.find((g) => g.prefix === guard.glob);
    if (!broad) continue;
    const denied = deny.map(bashInner).filter(Boolean).some((d) => d.startsWith(guard.requireDenyPrefix));
    if (!denied) findings.pushGuard.push(guard);
  }

  definiteIssues += findings.superseded.length + findings.mcpRedundant.length;
  reports.push(findings);
}

// --- 6. cross-file drift ------------------------------------------------------
let drift = null;
const good = reports.filter((r) => !r.error);
if (good.length >= 2) {
  const sets = good.map((r) => ({ file: r.file, allow: new Set(r.allow), deny: new Set(r.deny) }));
  const union = (key) => new Set(sets.flatMap((s) => [...s[key]]));
  const mismatch = (key) => {
    const out = [];
    for (const entry of union(key)) {
      if (isSiteSpecific(entry)) continue;
      const present = sets.filter((s) => s[key].has(entry)).map((s) => s.file);
      if (present.length !== sets.length) out.push({ entry, present, missing: sets.filter((s) => !s[key].has(entry)).map((s) => s.file) });
    }
    return out;
  };
  drift = { allow: mismatch('allow'), deny: mismatch('deny') };
}

// --- report -------------------------------------------------------------------
const short = (f) => f.replace(process.env.HOME ?? '~', '~').replace(/\/.claude\/settings\.local\.json$/, '');
let total = 0;

for (const r of reports) {
  console.log('\n' + C.bold(short(r.file)));
  if (r.error) {
    console.log('  ' + C.red('✗ ' + r.error));
    total++;
    continue;
  }
  const n = r.superseded.length + r.mcpRedundant.length + r.mcpConsolidate.length + r.sensitiveWildcard.length + r.sensitiveKeep.length + r.deadOneOff.length + r.pushGuard.length;
  total += n;
  if (n === 0) {
    console.log('  ' + C.green('✓ clean') + C.dim(` (${r.allow.length} allow, ${r.deny.length} deny)`));
    continue;
  }
  for (const s of r.superseded) console.log('  ' + C.red('superseded ') + `${s.entry}` + C.dim(`  ← covered by ${s.by}`));
  for (const m of r.mcpRedundant) console.log('  ' + C.red('redundant  ') + `${m.entry}` + C.dim(`  ← covered by ${m.by}`));
  for (const m of r.mcpConsolidate) console.log('  ' + C.yellow('consolidate ') + C.dim(`${m.count} ${m.server} tools → `) + m.suggest);
  for (const s of r.sensitiveWildcard) console.log('  ' + C.yellow('sensitive-* ') + s.entry + C.dim('  (advisory — wildcard auto-approves send/delete-class + future tools; consider enumerating instead)'));
  for (const s of r.sensitiveKeep) console.log('  ' + C.dim(`enumerated  ${s.count} ${s.server} tools — kept as-is (sensitive server; consolidation deliberately not suggested)`));
  for (const d of r.deadOneOff) console.log('  ' + C.yellow('one-off?   ') + `${d.entry}` + C.dim('  (advisory — looks single-use)'));
  for (const g of r.pushGuard) console.log('  ' + C.yellow('push-guard ') + C.dim(`Bash(${g.glob} *) allowed but no '${g.requireDenyPrefix}' deny — ${g.why}`));
}

if (drift) {
  const driftCount = drift.allow.length + drift.deny.length;
  console.log('\n' + C.bold('cross-project drift'));
  if (driftCount === 0) {
    console.log('  ' + C.green('✓ allow/deny lists match') + C.dim(' (ignoring site-specific entries)'));
  } else {
    total += driftCount;
    for (const d of [...drift.allow.map((x) => ({ ...x, list: 'allow' })), ...drift.deny.map((x) => ({ ...x, list: 'deny' }))]) {
      console.log('  ' + C.yellow(`${d.list} drift `) + d.entry + C.dim(`  (missing from: ${d.missing.map(short).join(', ')})`));
    }
  }
}

console.log('\n' + C.dim(`— ${total} finding(s); ${definiteIssues} definite (superseded/redundant)`));
process.exit(ci && definiteIssues > 0 ? 1 : 0);
