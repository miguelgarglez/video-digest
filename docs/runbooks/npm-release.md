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

## Publishing a new version

1. Update `package.json` to the next semver version.
2. Run the local release-readiness suite:

   ```bash
   bun install --frozen-lockfile
   bun test
   bun run typecheck
   bun run verify:package
   bun run smoke:package
   ```

3. Merge the version bump to `main`.
4. Open GitHub Actions → `Publish npm package` → `Run workflow`.
5. Select branch `main`.
6. Enter the exact version from `package.json`.
7. Approve the `npm-production` GitHub environment deployment if prompted.

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
