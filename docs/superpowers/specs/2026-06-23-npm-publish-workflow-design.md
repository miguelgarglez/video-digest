# npm Publish Workflow Design

## Goal

Add a repeatable, manual, supply-chain-aware workflow for publishing future
`video-digest` versions to npm after the package's first manual publication.

## Current state

`video-digest@0.1.0` exists on npm. The repository already has a macOS ARM quality
workflow that verifies the package, but it intentionally cannot publish.

## Release model

Publishing is manual through GitHub Actions `workflow_dispatch`. The operator provides
the exact version to publish. The workflow refuses to run unless:

- it is executed from `main`;
- `package.json.name` is `video-digest`;
- `package.json.version` matches the workflow input;
- `npm view video-digest@<version>` reports the version is not already published;
- the complete release-readiness suite passes.

The workflow uses npm Trusted Publishing through GitHub Actions OIDC instead of
long-lived npm tokens. It grants only `contents: read` and `id-token: write`, uses a
GitHub-hosted macOS ARM runner, sets up Node 24 so npm Trusted Publishing has a
compatible Node/npm runtime, and publishes with `npm publish --access public`.

The npm package should configure a Trusted Publisher for:

- owner/repository: `miguelgarglez/personal-video-digest`;
- workflow filename: `npm-publish.yml`;
- optional GitHub environment: `npm-production`;
- allowed action: `npm publish`.

## Safety properties

The workflow does not accept arbitrary package names or publish from branches other
than `main`. It does not use `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or repository secrets.
GitHub environment protection can add a human approval gate outside the YAML.

The runbook documents how to configure npm Trusted Publishing, how to publish a new
version, and how to verify the published package after the workflow completes.

## Sources checked

- npm Trusted Publishing docs, including GitHub Actions fields and automatic
  provenance.
- npm provenance docs.
- GitHub Actions Node package publishing docs.
