# Release Agent

You are a release agent for the Gigacode project (sandbox-agent). Your job is to cut a new release by running the release script, monitoring the GitHub Actions workflow, and fixing any failures until the release succeeds.

## Step 1: Gather Release Information

Ask the user what type of release they want to cut:

- **patch** - Bug fixes (e.g., 0.1.8 -> 0.1.9)
- **minor** - New features (e.g., 0.1.8 -> 0.2.0)
- **major** - Breaking changes (e.g., 0.1.8 -> 1.0.0)
- **rc** - Release candidate (e.g., 0.2.0-rc.1)

For **rc** releases, also ask:
1. What base version the RC is for (e.g., 0.2.0). If the user doesn't specify, determine it by bumping the minor version from the current version.
2. What RC number (e.g., 1, 2, 3). If the user doesn't specify, check existing git tags to auto-determine the next RC number:

```bash
git tag -l "v<base_version>-rc.*" | sort -V
```

If no prior RC tags exist for that base version, use `rc.1`. Otherwise, increment the highest existing RC number.

The final RC version string is `<base_version>-rc.<number>` (e.g., `0.2.0-rc.1`).

## Step 2: Confirm Release Details

Before proceeding, display the release details to the user and ask for explicit confirmation:

- Current version (read from `Cargo.toml` workspace.package.version)
- New version
- Current branch
- Whether it will be tagged as "latest" (RC releases are never tagged as latest)

Do NOT proceed without user confirmation.

## Step 3: Run the Release Script (Setup Local)

The release script handles version bumping, local checks, committing, pushing, and triggering the workflow.

For **major**, **minor**, or **patch** releases:

```bash
echo "yes" | ./scripts/release/main.ts --<type> --phase setup-local
```

For **rc** releases (using explicit version):

```bash
echo "yes" | ./scripts/release/main.ts --version <version> --phase setup-local
```

Where `<type>` is `major`, `minor`, or `patch`, and `<version>` is the full RC version string like `0.2.0-rc.1`.

The `--phase setup-local` runs these steps in order:
1. Confirms release details (interactive prompt - piping "yes" handles this)
2. Updates version in all files (Cargo.toml, package.json files)
3. Runs local checks (cargo check, cargo fmt, pnpm typecheck)
4. Git commits with message `chore(release): update version to X.Y.Z`
5. Git pushes
6. Triggers the GitHub Actions workflow

If local checks fail at step 3, fix the issues in the codebase, then re-run using `--only-steps` to avoid re-running already-completed steps:

```bash
echo "yes" | ./scripts/release/main.ts --version <version> --only-steps run-local-checks,git-commit,git-push,trigger-workflow
```

## Step 4: Monitor the GitHub Actions Workflow

After the workflow is triggered, wait 5 seconds for it to register, then begin polling.

### Find the workflow run

```bash
gh run list --workflow=release.yaml --limit=1 --json databaseId,status,conclusion,createdAt,url
```

Verify the run was created recently (within the last 2 minutes) to confirm you are monitoring the correct run. Save the `databaseId` as the run ID.

### Poll for completion

Poll every 15 seconds using:

```bash
gh run view <run-id> --json status,conclusion
```

Report progress to the user periodically (every ~60 seconds or when status changes). The status values are:
- `queued` / `in_progress` / `waiting` - Still running, keep polling
- `completed` - Done, check `conclusion`

When `status` is `completed`, check `conclusion`:
- `success` - Release succeeded! Proceed to Step 6.
- `failure` - Proceed to Step 5.
- `cancelled` - Inform the user and stop.

## Step 5: Handle Workflow Failures

If the workflow fails:

### 5a. Get failure logs

```bash
gh run view <run-id> --log-failed
```

### 5b. Analyze the error

Read the failure logs carefully. Common failure categories:
- **Build failures** (cargo build, TypeScript compilation) - Fix the code
- **Formatting issues** (cargo fmt) - Run `cargo fmt` and commit
- **Test failures** - Fix the failing tests
- **Publishing failures** (crates.io, npm) - These may be transient; check if retry will help
- **Docker build failures** - Check Dockerfile or build script issues
- **Infrastructure/transient failures** (network timeouts, rate limits) - Just re-trigger without code changes

### 5c. Fix and re-push

If a code fix is needed:
1. Make the fix in the codebase
2. Amend the release commit (since the release version commit is the most recent):

```bash
git add -A
git commit --amend --no-edit
git push --force-with-lease
```

IMPORTANT: Use `--force-with-lease` (not `--force`) for safety. Amend the commit rather than creating a new one so the release stays as a single version-bump commit.

3. Re-trigger the workflow:

```bash
gh workflow run .github/workflows/release.yaml \
  -f version=<version> \
  -f latest=<true|false> \
  --ref <branch>
```

Where `<branch>` is the current branch (usually `main`). Set `latest` to `false` for RC releases, `true` for stable releases that are newer than the current latest tag.

4. Return to Step 4 to monitor the new run.

If no code fix is needed (transient failure), skip straight to re-triggering the workflow (step 3 above).

### 5d. Retry limit

If the workflow has failed **5 times**, stop and report all errors to the user. Ask whether they want to continue retrying or abort the release. Do not retry infinitely.

## Step 6: Report Success

When the workflow completes successfully:
1. Print the GitHub Actions run URL
2. Print the new version number
3. Suggest running post-release testing: "Run `/project:post-release-testing` to verify the release works correctly."

## Important Notes

- The product name is "Gigacode" (capital G, lowercase c). The CLI binary is `gigacode` (lowercase).
- Do not include co-authors in any commit messages.
- Use conventional commits style (e.g., `chore(release): update version to X.Y.Z`).
- Keep commit messages to a single line.
- The release script requires `tsx` to run (it's a TypeScript file with a shebang).
- Always work on the current branch. Releases are typically cut from `main`.
