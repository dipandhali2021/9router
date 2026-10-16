# Merging upstream releases — reference playbook

Everything here was verified against real merges (v1.5.99 and v1.5.104 of the fork).
Paths are relative to the repo root. `X.Y.Z` = the upstream version; fork version is `1.Y.Z` while upstream is `0.Y.Z`.

---

## §A Fork inventory & protected surface

Before merging, enumerate what must survive:

```bash
git fetch upstream --tags
LAST_SYNC=$(git log --format=%H -1 --grep='Merge upstream/master' master)   # previous merge commit
git log --oneline upstream/master..HEAD > /tmp/opencode/fork-only-commits.txt   # features to protect
git diff --stat $LAST_SYNC..upstream/master > /tmp/opencode/upstream-delta.txt  # what's incoming
```

Known fork feature families (seen in recent merges): qwen / fal-ai / replicate media providers; universal custom-endpoint nodes; proxy-pool relay import; provider Playground + Capabilities cards (`pickUiCaps`); structured live console log page; per-request ids; optional PostgreSQL backend; AES-256-GCM encryption at rest; `resolveComboStrategy` + `shouldFallbackFn` (combo.js); `stripSmuggledToolIdSignature` (relay `~sig1:` tool-id cut); per-node `safeLogoUrl`; CI publish workflows; tarball pack workflow.

After resolving conflicts, grep for a few of these identifiers to prove they survived:
`resolveComboStrategy`, `shouldFallbackFn`, `stripSmuggledToolIdSignature`, `safeLogoUrl`, `pickUiCaps`, `replicate`, `fal-ai`.

---

## §B Conflict playbook (file → rule → precedent)

Resolve by **combining both sides**. Use the merge tool or hand-edit; `git checkout --ours/--theirs` is only ever a starting point, never the final answer.

| File / area | Rule |
|---|---|
| `package.json`, `cli/package.json` | Name stays `@dipandhali2021/9router`; version = new fork version in BOTH files. |
| `open-sse/providers/registry/index.js` | Fork media providers continue **past upstream's highest index** — v1.5.104 landed at: nous p138 (upstream), qwen p139, replicate p140. Never collide indexes. |
| `open-sse/translator/concerns/claudeMessage.js` (+ `handlers/chatCore/*`) | Upstream refactors MOVE functions between files (v0.5.104 hoisted `openAICompletionToClaudeMessage` out of `nonStreamingHandler.js`). Find the fork hook in the deleted/old code and re-apply it at the new home (`stripSmuggledToolIdSignature` lives here now). |
| `open-sse/services/combo.js` | Keep BOTH fork `resolveComboStrategy` (+ `shouldFallbackFn`) AND upstream's `isZeroContentResponse` fallback. |
| `src/shared/hooks/useModelCaps.js` | Combine fork `pickUiCaps` projection with upstream `ALIAS_TO_ID` resolution. |
| `src/app/api/models/route.js` | Combine both import sets. |
| `src/lib/db/repos/nodesRepo.js` | Upstream's custom-model prune runs inside the fork's awaited transaction contract. |
| `src/shared/components/ModelSelectModal.js` | Upstream features (wildcard/select-all, live connections fetch) + fork `safeLogoUrl` in the provider header. |
| `src/shared/utils/index.js` | Export both sides' symbols. |
| `CHANGELOG.md` | New fork entry `v1.Y.Z` (fork format) + upstream `vX.Y.Z` section placed above the previous upstream section; trim the tail to match upstream's retention. |
| `tests/__baseline__/*.json` | REGENERATE, never hand-merge (see §C). |
| `tests/translator/__snapshots__/golden-url-header.test.js.snap` | Regenerate with `-u`, then inspect (see §C). |
| `next.config.mjs` | Keep fork externals (`pg`) alongside upstream's additions. |

Precedent resolutions worth re-reading: commit `c6900216` (v1.5.104) and its predecessor (v1.5.99) — `git show <merge-commit> --stat` plus the commit message's "Conflict resolutions of note" section.

---

## §C Test methodology (the "proper testing")

**The suite is not all-green by design. Green/red is judged by SET comparison against a pre-merge capture.**

### C1. Commands

```bash
# BEFORE the merge (right after step 2):
cd tests && npx vitest run --reporter=json --outputFile=/tmp/opencode/vitest-pre-merge.json
# (add --reporter=default > /tmp/opencode/vitest-pre-merge.log if you want console output)

# AFTER the merge, when all conflicts are resolved and staged:
cd tests && npx vitest run --reporter=json --outputFile=/tmp/opencode/vitest-post-merge.json
```

**Run the post-merge suite ALONE.** Concurrent eslint/builds caused two reproducible false signals (2026-10-16): zed-native-auth's `beforeAll` hit its 10 s hook timeout under load (all 12 tests reported `skipped`, file marked failed), and xai-oauth-service's 5 s test timeouts fired. Both files passed when isolated.

### C2. Set comparison

```python
# /tmp/opencode/compare-fails.py — usage: python3 compare-fails.py pre.json post.json
import json, sys

def load(p):
    data = json.load(open(p))
    fails = set()
    for tr in data.get("testResults", []):
        for a in tr.get("assertionResults", []):
            name = tr.get("name", "") + " :: " + (a.get("fullName") or a.get("title"))
            if a["status"] == "failed":
                fails.add(name)
    return fails

pre, post = load(sys.argv[1]), load(sys.argv[2])
new, fixed = post - pre, pre - post
print(f"New failures vs pre-merge: {len(new)}")
for n in sorted(new): print("  NEW:", n)
print(f"Fixed vs pre-merge: {len(fixed)}")
for n in sorted(fixed): print("  FIXED:", n)
print("Verdict:", "NEW FAILURES - classify each" if new else "0 new failures")
```

Also extract per-run totals for the commit message: passed / failed / skipped / todo, and note "expected fail" counts separately (console line: `Tests NN failed | ... | NN expected fail | ...`).

### C3. Classifying a "NEW" failure (flake vs real regression)

1. Re-run just that file in isolation: `cd tests && npx vitest run <file>`. Passes → flake candidate.
2. `git diff HEAD -- <test-file> <code-under-test>` — if **byte-identical to the pre-merge HEAD**, the merge cannot have caused it. Strongest proof; quote it in the commit message.
3. Known signatures:
   - **zed-native-auth**: `Hook timed out in 10000ms` on `beforeAll` under CPU load → 12 "skipped". Cause: heavy concurrent jobs, not code.
   - **xai-oauth-service**: first cold dynamic import of the whole provider graph takes ~2.8–3.6 s against the 5 s default timeout; under load it crosses → `Test timed out in 5000ms`, sometimes cascading into a second failure. Reproduces at HEAD; file unchanged.
   - Also treat any test whose name/files are untouched and that passes isolated as pre-existing flake — but only after steps 1+2.
4. Only an unexplained failure that survives isolation and/or sits in changed code is a real regression — fix it or stop the release.

### C4. Baselines and snapshots

```bash
node tests/__baseline__/snapshot-providers.mjs            # regenerate providers-baseline.json
node tests/__baseline__/verify-alias.mjs --snapshot       # regenerate alias-baseline.json
node tests/__baseline__/verify-oauth-urls.mjs --snapshot  # regenerate oauth-urls-baseline.json
# then verify green (no --snapshot):
node tests/__baseline__/verify-providers.mjs && node tests/__baseline__/verify-alias.mjs && node tests/__baseline__/verify-oauth-urls.mjs
```

`verify-no-regression.mjs` + `known-fails.txt` are legacy (path-format-sensitive, expects `/app/` layout) — prefer the dynamic pre/post capture above.

Golden header snapshots contain the fork version string:

```bash
cd tests && npx vitest run translator/golden-url-header.test.js -u
git diff -- tests/translator/__snapshots__/golden-url-header.test.js.snap
```

The diff must contain **only** version-string updates (e.g. `1.5.99 → 1.5.104` in User-Agent / X-CLIENT-VERSION / X-CORE-VERSION / X-Msh-Version) plus, at most, snapshot entries for genuinely new providers. Anything else → investigate.
Note: vitest **auto-writes brand-new snapshots** in local (non-CI) runs. After any full-suite run, `git status` may show new additions inside `.snap` files — inspect and stage them deliberately as part of the merge.

---

## §D ESLint comparison vs HEAD

No CI lint gate; the goal is "no NEW errors versus pre-merge on the same file set", not zero.

```bash
# Run while the merge is still uncommitted (HEAD = old master), or use <merge>^1 after committing:
git worktree add --detach /tmp/opencode/head-check HEAD
ln -sfn "$PWD/node_modules" /tmp/opencode/head-check/node_modules
ln -sfn "$PWD/tests/node_modules" /tmp/opencode/head-check/tests/node_modules

# Same file list on both sides, JSON output, compare error counts per file:
git diff --cached --name-only --diff-filter=ACMR | grep -E '\.(js|jsx|mjs|cjs)$' > /tmp/opencode/merged-files.txt
(cd /tmp/opencode/head-check && while read -r f; do [ -f "$f" ] && echo "$f"; done < /tmp/opencode/merged-files.txt | xargs npx eslint --no-warn-ignored -f json > /tmp/opencode/eslint-head.json)
xargs < /tmp/opencode/merged-files.txt npx eslint --no-warn-ignored -f json > /tmp/opencode/eslint-merged.json

# cleanup when done:
git worktree remove /tmp/opencode/head-check --force
```

Sanity: confirm `git diff HEAD -- eslint.config.mjs package.json` shows no eslint config/dep change; if the ruleset changed, compare rulesets before counts.
Accepted pre-existing pattern: `react-hooks/set-state-in-effect` fires ~19× across merge-touched files. One additional hit inside upstream's own newly added effect is acceptable — do not restructure upstream code for it.

---

## §E Release verification cookbook

### Workflow facts (verified in `.github/workflows/`)

- **npm-publish.yml** — `v*` tag (or `workflow_dispatch` with `dry_run`/`dist_tag`/`provenance` inputs). Fails fast if the tag ≠ `cli/package.json` version. If the version already exists on npm it **skips cleanly** (rerun-safe). Stable versions get dist-tag `latest`.
- **docker-publish.yml** — `v*` tag (or `workflow_dispatch` with required `release_tag` + optional `promote_latest`). Fails fast if the tag ≠ **both** `package.json` and `cli/package.json`. Builds linux/amd64 + linux/arm64, smoke-tests `/api/health` on each platform AND on the resolved manifest, publishes GHCR always + Docker Hub when repo is `dipandhali2021/9router`, promotes `latest` for stable tag pushes.
- Neither workflow triggers on master pushes.

### Watching

```bash
gh run list --repo dipandhali2021/9router --limit 8
gh run watch <run-id> --repo dipandhali2021/9router --exit-status
gh run view <run-id> --repo dipandhali2021/9router --log-failed   # when red
```

### Verifying artifacts actually published (workflow green ≠ artifact exists)

**npm processes large packages asynchronously.** A green npm run may log `npm notice Your package is being processed and may take a few minutes to become available.` followed by `+ @dipandhali2021/9router@X.Y.Z` — and the version still 404s on the registry for several minutes. Absence right after the run is NOT a failure: poll until it appears, and never re-dispatch the workflow while it's processing (that race is what produces the duplicate failed dispatch runs).

```bash
# poll until the version surfaces (20 s interval):
for i in $(seq 1 40); do
  curl -sf "https://registry.npmjs.org/@dipandhali2021%2F9router/X.Y.Z" >/dev/null && { echo "visible after $i polls"; break; }
  sleep 20
done
```

```bash
# npm:
npm view @dipandhali2021/9router@<ver> version dist.tarball
npm view @dipandhali2021/9router dist-tags          # latest -> <ver>
npm i -g @dipandhali2021/9router@<ver> && 9router --version   # optional end-to-end

# Docker (Docker CLI primary):
docker manifest inspect dipandhali2021/9router:<ver>   # amd64 + arm64 entries expected
docker manifest inspect dipandhali2021/9router:latest
docker manifest inspect ghcr.io/dipandhali2021/9router:<ver>

# Docker Hub without the Docker CLI (auth-free for public repos):
curl -s "https://hub.docker.com/v2/repositories/dipandhali2021/9router/tags/<ver>" | jq -r '.name, .last_updated'
```

Both the version tag AND `latest` should point at the new release for stable versions.

### Partial-failure playbook

- **Merge/test failure, pre-push**: `git merge --abort`, or `git reset --hard backup/pre-<ver>`; retry.
- **CI red after push**: `gh run view --log-failed`, fix, push a follow-up commit, `gh run rerun <id>` — or delete/re-push the tag if it was wrong and *nothing has been published yet*.
- **npm ok, docker red**: rerun the docker workflow via `workflow_dispatch` (`release_tag: v<ver>`).
- **docker ok, npm red**: fix and rerun the npm workflow (already-published skip makes reruns safe) or dispatch with inputs.
- **npm published but broken**: npm versions are immutable — never reuse the number; bump patch, re-tag, release again.
- Known harmless quirk: a duplicate "Publish CLI to npm" `workflow_dispatch` run has appeared after a successful release (v1.5.99 + v1.5.104) and failed — most likely a republish attempt made while npm was still async-processing the big tarball. Check `---workflow_dispatch---` vs tag-triggered runs, and poll the registry before concluding anything is missing.

---

## §F Traps archive

- Untracked `dipandhali2021-9router-*.tgz` (16 MB) sits in the repo root from local packing — never stage it, never `git add -A`.
- No `package-lock.json` is committed (upstream's choice: a lockfile would conflict every sync). CI does `npm install`; don't fight it.
- Exit codes ≠ results: vitest exits 1 when any test fails — expected. Judge by sets.
- Don't `npm install` mid-merge: the local release build uses the existing `node_modules`/`.next`.
- `git fetch upstream --tags` warns "would clobber existing tag v0.5.65" — stale local tag, diverged from upstream on purpose. Leave it.
- `tests/vitest.config.js` excludes `**/.claude/**` worktrees because they carry test copies without `node_modules`.
- Only push `master` and the new release tag. The backup branch stays local.
- The merge commit message is the project's merge log — keep the section format (see §G); future sessions read it to reconstruct fork features.

---

## §G Merge commit message template

```
Merge upstream/master (vX.Y.Z) into master

Sync the fork with decolua/9router up to vX.Y.Z, preserving every
fork-specific feature. Fork and CLI versions move to 1.Y.Z.

Upstream features integrated:
- <feature> (<area>)

Fork work preserved:
- <feature family, one line each — carry forward from the previous merge message>
- <...>

Conflict resolutions of note:
- <file>: <why the two sides were combined this way>

Test/baseline housekeeping:
- providers / alias baselines regenerated after the registry change (<N> providers; <what changed>)
- CHANGELOG: new v1.Y.Z entry plus the upstream vX.Y.Z section

Verified: 0 unexplained test regressions vs the pre-merge baseline
(<pre> pass / <pre> fail before → <post> pass / <post> fail / <total> after;
<flips> upstream-fixed tests now pass). <Any delta reds and exactly why they are
flakes: file untouched by the merge, passes isolated, signature>.
Golden-header snapshots updated for the version bump only. Baselines verify
green. ESLint: no new hits beyond <...>. next build and the CLI package build
both succeed.
```

Write it to a file and `git commit --file <file>` while the merge is in progress (MERGE_HEAD set). Verify two parents afterwards: `git log --format='parents: %P' -1`.
