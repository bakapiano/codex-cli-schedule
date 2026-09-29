# Publishing to npm

Package: `@bakapiano/codex-cli-schedule`.

## First publication

Use Node.js 24+ and an npm account with publishing rights for the `@bakapiano` scope. The package's `publishConfig` selects the public npm registry and public access.

```powershell
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm ci --registry=https://registry.npmjs.org/
npm test
npm pack --dry-run
npm publish --access public --registry=https://registry.npmjs.org/
```

Complete the npm verification prompt when requested. Check the published package from a fresh directory:

```powershell
npm view @bakapiano/codex-cli-schedule version --registry=https://registry.npmjs.org/
npx --yes --registry=https://registry.npmjs.org/ @bakapiano/codex-cli-schedule --version
```

## Connect GitHub Actions to npm

After the first publication, open the package's settings on npm and add a GitHub Actions trusted publisher with these exact values:

| Setting | Value |
| --- | --- |
| Organization or user | `bakapiano` |
| Repository | `codex-cli-schedule` |
| Workflow filename | `publish.yml` |
| Environment | `npm` |

Enable direct publishing through `npm publish` for this trusted publisher. The workflow uses GitHub-hosted runners, Node.js 24, npm 11, and `id-token: write` to obtain a short-lived publishing credential. The `npm` GitHub environment can be configured with required reviewers for a release approval step.

Commit and push `.github/workflows/publish.yml` and the accompanying package changes before preparing the next release. The workflow runs when a stable GitHub Release is published; its tag must match the version in both `package.json` and `package-lock.json`.

Official reference: <https://docs.npmjs.com/trusted-publishers/>.

## Subsequent releases

Starting from a clean, up-to-date `main` branch with the publishing setup committed:

```powershell
npm ci --registry=https://registry.npmjs.org/
npm test
npm version patch
git push origin main --follow-tags
```

Create and publish a GitHub Release for the new tag, for example `v0.1.1`. The workflow:

1. Checks that the stable release tag and package versions agree.
2. Tests and inspects the package on Windows and Linux.
3. Publishes the compiled package publicly with provenance using npm trusted publishing.

Choose a fresh version for every release. The initial `0.1.0` publication is performed locally; use the workflow starting with the next version. Prerelease distribution can be added as a separate, explicitly tagged release path.
