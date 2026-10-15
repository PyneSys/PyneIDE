# Releasing PyneIDE

Pushing a version tag runs CI and creates a draft GitHub release with a VSIX,
release notes and SHA-256 checksums. Publishing the draft is manual.

## Prepare

Update the extension version with `npm version <version> --no-git-tag-version`.
This updates `package.json` and `package-lock.json`. Use a numeric
`major.minor.patch` version for each build you distribute.

Set `preview` in `package.json` to `true` for a preview or `false` for a stable
release. The workflow uses this field to set the GitHub pre-release flag.

Move the changes being released from `[Unreleased]` into a
`## [<version>] - YYYY-MM-DD` section in `CHANGELOG.md`. That section becomes
the release notes.

Run the checks and package the extension:

```bash
npm ci
release_version=$(node -p "require('./package.json').version")
npm run release:check -- "v$release_version"
npm run test:release
npm run check
npm run build
npm run test:grammar
npm run test:report
npm run test:agent-skills
npm run test:env
npm run package
```

Review `build/release-notes.md`. Install the VSIX from `build/` in a separate
VS Code profile and check environment setup, compilation, running and debugging.

## Create the draft

Commit the reviewed changes and push them to `main`. From the release commit,
create and push the tag:

```bash
release_version=$(node -p "require('./package.json').version")
git tag -a "v$release_version" -m "PyneIDE $release_version"
git push origin "v$release_version"
```

The tag must match the package version. The Release workflow runs CI, including
environment tests on Linux, macOS and Windows. Once all jobs pass, it attaches
the VSIX from that CI run to a draft release. It uses the built-in GitHub token;
no additional secret is required.

## Publish

Open the draft under GitHub Releases. Review the notes, pre-release flag and
attached VSIX, then publish it. This workflow only publishes to GitHub Releases.

Users install the downloaded VSIX through **Extensions: Install from VSIX…**
in VS Code. Distribute each new build to testers; these installs do not update
automatically.

For a transient CI failure, use **Re-run all jobs**. Rerunning refreshes an
existing draft, but refuses to modify a published release. If the release needs
a code change, prepare a new version rather than moving a distributed tag.
