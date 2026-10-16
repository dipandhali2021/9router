---
name: merging-upstream-releases
description: Use when decolua/9router (upstream) publishes a new release and the dipandhali2021/9router fork must absorb it — "merge the upstream release", "sync the fork", "upstream vX is out", "publish the new 9router release". Symptoms: an upstream tag newer than the fork's last "Merge upstream/master" commit, or about to bump fork versions, resolve upstream-vs-fork merge conflicts, tag a release, or verify an npm/Docker publish for this fork.
metadata:
  opencode/slash: "true"
---

# Merging Upstream Releases into the 9router Fork

## Overview

- `origin` = **dipandhali2021/9router** (the fork; publishes). `upstream` = **decolua/9router**.
- One `v*` tag = one release. Tag push triggers both workflows:
  - `.github/workflows/npm-publish.yml` → npm `@dipandhali2021/9router` (built from `cli/`)
  - `.github/workflows/docker-publish.yml` → Docker Hub `dipandhali2021/9router` + GHCR (multi-arch, promotes `latest`)
- **Fork versions map `0.X.Y → 1.X.Y`** (upstream v0.5.104 → fork v1.5.104). If upstream changes minor/major, ask the user for the new mapping.
- Merge in place on `master` in the main checkout. Merge commit, never rebase, no PRs.
- The test suite is **not all-green by design**. Judge only by comparing failure SETS against a pre-merge capture; counts alone mean nothing.

**Non-negotiables: every incoming upstream feature AND every existing fork feature must survive the merge; the release is only done when the npm package and the Docker image are verified queryable.**

## Phases

0. **Preflight** — `git status` clean (ignore untracked `dipandhali2021-9router-*.tgz` pack leftovers — never stage them; `git add -A` is banned in this repo). Check `git remote -v` (origin=fork, upstream=decolua/9router), `gh auth status`, `gh secret list --repo dipandhali2021/9router` (need NPM_TOKEN, DOCKERHUB_USERNAME, DOCKERHUB_TOKEN).
1. **Identify the release** — `git fetch upstream --tags` (a "would clobber existing tag v0.5.65" warning is a known local quirk — ignore it). Candidate = newest upstream tag. If the release/version you were told about does not exist upstream, STOP and report — never merge some other tag instead. `git log --oneline <last-sync-commit>..<upstream/master>` and `git diff --stat` to size it up. Decide the fork version per the mapping.
2. **Backup branch** — `git branch backup/pre-<version>` at current master.
3. **Pre-merge test baseline (BEFORE any code changes)** — full suite → JSON + fail list; run the four byte-baseline verifiers. This snapshot is what "no regressions" is measured against. Recipe: reference.md §C.
4. **Merge** — `git merge --no-commit --no-ff upstream/master`, keep it uncommitted while resolving. If it explodes: `git merge --abort` (backup branch is the hard fallback).
5. **Resolve conflicts** — playbook in reference.md §B. Ground rules: never resolve a feature file with a wholesale `--ours`/`--theirs`; combine both sides. Upstream refactors MOVE fork code — port fork hooks to the new home. Generated artifacts (baselines, registry index, golden snapshots, CHANGELOG) are REGENERATED, not hand-merged. Stage explicitly per path.
6. **Version bump + changelog** — the same new version in **both** `package.json` and `cli/package.json` (CI validates tag vs both). CHANGELOG: fork entry + upstream section, trim tail. Format: §B.
7. **Verify the merge** — details in §C/§D:
   - a. Full suite **run alone** (no eslint/builds in parallel — CPU contention manufactures false failures).
   - b. Set-compare failures vs the pre-merge capture; classify every delta (flake vs real) with the protocol in §C.
   - c. Golden snapshots: `cd tests && npx vitest run translator/golden-url-header.test.js -u`, then inspect the `.snap` diff (version strings + new providers only) and stage deliberately.
   - d. ESLint comparison vs HEAD worktree (§D); no NEW errors beyond accepted pre-existing patterns.
   - e. `npm run build` and `cd cli && npm run build` — both must exit 0.
8. **Commit the merge** — merge-in-progress state (MERGE_HEAD set), message template §G, `git commit --file <msgfile>`. Verify parents: `git log --format='parents: %P' -1` shows two.
9. **Release** — `git push origin master`; `git tag v<version>` on the merge commit; push the tag. Watch BOTH runs (`gh run list` / `gh run watch`), then verify artifacts — **workflow green is not enough, query npm and Docker Hub directly** (§E). npm processes large packages **asynchronously**: a green npm run can say "Your package is being processed and may take a few minutes to become available" and the version surfaces minutes later — poll the registry, and never re-dispatch the workflow while it's processing. Partial failure playbook: §E.
10. **Cleanup & knowledge** — remove temp worktrees, keep the backup branch, and append any new conflict resolution or trap to reference.md so the next merge is cheaper.

## Red flags — stop and check

| Thought | Reality |
|---|---|
| "`git add -A` to stage the merge" | Stages the untracked tarball. Stage explicit paths only. |
| "91 failing tests — the merge broke it" | Same red set as before until proven otherwise. Compare SETS, not counts. |
| "No time for the pre-merge baseline" | Without it you cannot say "0 regressions" — the whole verification collapses. |
| "`--theirs` fixes this conflict" | Kills fork features. Combine, then port moved fork hooks to their new home. |
| "CI is green — release done" | Green ≠ published. Query the npm registry and Docker Hub/API. |
| "Run eslint/build while the final suite runs" | Contention creates fake failures (zed hook timeout, xai 5s timeout). Serialize. |
| "Tag now, fix versions after" | Both `package.json`s must equal the tag before you push it. |
| "Rebase is cleaner" | Never rebase the fork onto upstream. Merge commits only. |
| "Editing the baseline JSON by hand" | Regenerate with the snapshot scripts; hand edits drift. |
