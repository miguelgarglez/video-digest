# npm release runbook

This runbook publishes future `video-digest` versions through GitHub Actions and npm
Trusted Publisher. It assumes the first manual publication has already created the npm
package.

## One-time npm setup

Configure a Trusted Publisher for `video-digest` on npm.

Recommended CLI form:

```bash
npm trust github video-digest \
  --repo miguelgarglez/personal-video-digest \
  --file npm-publish.yml \
  --environment npm-production \
  --allow-publish
```

Use npm `11.17.0` or newer for this command. Older npm versions may not expose the
Trusted Publisher permission flags.

Equivalent npmjs.com fields:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `miguelgarglez` |
| Repository | `personal-video-digest` |
| Workflow filename | `npm-publish.yml` |
| Environment name | `npm-production` |
| Allowed action | `npm publish` |

After the first successful trusted publish, configure npm publishing access to require
two-factor authentication and disallow traditional automation tokens. Trusted Publisher
publishes continue to work through short-lived OIDC credentials.

## One-time GitHub setup

Create the GitHub environment `npm-production`.

Recommended protection:

- required reviewers: Miguel;
- deployment branches: `main` only;
- no environment secrets are required.

The workflow itself is manual-only through `workflow_dispatch`, refuses non-`main`
refs, and verifies the package identity before publishing.

## Release Please

Release Please runs on pushes to `main`, reads Conventional Commits, and maintains a
Release PR. That PR owns version bumps and `CHANGELOG.md`; merging it creates the
matching Git tag and GitHub Release.

When a Release PR appears:

1. Review the proposed `package.json` version and `CHANGELOG.md`.
2. Wait for CI on the Release PR.
3. Merge the Release PR when the release notes and version are correct.
4. Release Please will create the matching Git tag and GitHub Release.

Do not publish npm directly from the Release Please workflow. npm publication remains a
separate gated step through the Trusted Publishing workflow below.

## Publishing a new npm version

1. Merge the Release PR to `main`.
2. Run the local release-readiness suite:

   ```bash
   bun install --frozen-lockfile
   bun test
   bun run typecheck
   bun run verify:package
   bun run smoke:package
   ```

3. Open GitHub Actions → `Publish npm package` → `Run workflow`.
4. Select branch `main`.
5. Enter the exact version from the Release Please PR.
6. Approve the `npm-production` GitHub environment deployment if prompted.

The workflow will stop before publishing if:

- it is not running from `main`;
- the input version does not match `package.json`;
- the package name is not `video-digest`;
- that npm version already exists;
- any release-readiness gate fails.

## Post-publish verification

After the workflow succeeds:

```bash
npm view video-digest version
npm view video-digest dist-tags --json
npm install --global video-digest
video-digest --version
video-digest --help
```

Confirm that the published version matches the workflow input and that the npm package
page shows provenance for the new version.

## If a release is wrong

npm packages are effectively immutable once consumers may have installed them. Prefer
a corrective patch release over unpublishing. If the release should not be used,
deprecate the bad version with a clear message and publish a fixed version.
