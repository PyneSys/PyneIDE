# Releasing PyneIDE

Pushing a version tag runs CI and creates a draft GitHub release with a VSIX,
release notes and SHA-256 checksums. Publishing the draft starts the
`Publish Marketplace` and `Publish Open VSX` workflows. Both upload that same
VSIX independently. Marketplace uses Microsoft Entra workload identity
federation; Open VSX uses GitHub OIDC trusted publishing without a stored token.

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
python3 -m unittest discover -s test -p marketplace_test.py
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
attached VSIX, then publish it. The `release: published` event starts
`.github/workflows/marketplace.yml` and `.github/workflows/openvsx.yml`, including
for GitHub pre-releases.

The Marketplace workflow downloads the attached versioned VSIX and `SHA256SUMS`.
It verifies the checksum, archive integrity, publisher, extension ID, version and
Preview metadata against the tagged `package.json` and published GitHub release.
It publishes that package with `vsce publish --azure-credential --packagePath`;
it does not rebuild it. Keep `preview: true` until a stable release is intended.
The Marketplace Preview label is separate from its pre-release installation
channel; GitHub's pre-release flag does not opt into that channel.

Wait for the Marketplace job to finish, then verify the public
[PyneIDE listing](https://marketplace.visualstudio.com/items?itemName=pynesys.pyneide).
A successful upload can precede public availability while Marketplace validates
the package. Also wait for the Open VSX job and verify the
[Open VSX listing](https://open-vsx.org/extension/pynesys/pyneide). The Open VSX job
uses the same package checks and uploads the existing VSIX with `ovsx publish`.
A failure on either registry does not undo the GitHub release or prevent the
other registry's independent workflow from running.

Publish the GitHub draft through the UI or locally authenticated `gh`.
Events created using a workflow's built-in `GITHUB_TOKEN` do not start another
release-event workflow. If a future workflow publishes GitHub releases itself,
it must explicitly dispatch both publication workflows or call their publish
jobs.

Users can install from Marketplace or use the downloaded VSIX through
**Extensions: Install from VSIX…** in VS Code. Downloaded VSIX installations do
not provide their own automatic update mechanism.

For a transient CI failure, use **Re-run all jobs**. Rerunning refreshes an
existing draft, but refuses to modify a published release. If the release needs
a code change, prepare a new version rather than moving a distributed tag.

## One-time Open VSX setup

1. Sign in to [Open VSX](https://open-vsx.org) with your GitHub account. Create
   and link an Eclipse account when prompted, and sign the Eclipse Foundation
   Open VSX Publisher Agreement in your user settings. For a new Eclipse account,
   first connect the same GitHub identity under **Link GitHub Account** in the
   Eclipse account settings. Without it, Open VSX reports that the Eclipse profile
   is missing a GitHub username; that field is read-only in the profile editor.
2. Create namespace `pynesys` in Open VSX user settings. If it already exists,
   check its ownership instead of choosing another name: the namespace must
   match `package.json`. Request verified ownership through the Open VSX
   [namespace access process](https://github.com/eclipse-openvsx/openvsx/wiki/Namespace-Access).
   A matching Marketplace publisher can keep the extension inactive until the
   namespace is verified.
3. Create the repository's GitHub Actions environment `openvsx`. Allow tags
   matching `v*` and branch `main` for manual verification/retry runs. Leave
   required reviewers unset if publication should start automatically. No Open
   VSX token or secret is needed by the workflow.
4. If the extension has no active version yet, upload the checksummed VSIX from
   an existing published GitHub release through the
   [Open VSX publishing page](https://open-vsx.org/publish). Browser publication
   bootstraps the first version without a PAT. Confirm it is active before
   registering a trusted publisher.

### Switch to trusted publishing

Trusted publishing requires a signed Publisher Agreement, verified namespace
ownership and at least one active version of the extension. As the namespace
owner, register this configuration under
[Trusted Publishers](https://open-vsx.org/user-settings/trusted-publishers):

| Field       | Value         |
| ----------- | ------------- |
| Namespace   | `pynesys`     |
| Extension   | `pyneide`     |
| Owner       | `PyneSys`     |
| Repository  | `PyneIDE`     |
| Workflow    | `openvsx.yml` |
| Environment | `openvsx`     |

The workflow file must exist in the GitHub repository before registration. The
workflow uses `ovsx publish --trusted-publishing` and exchanges its GitHub OIDC
identity for a short-lived publishing token. It does not read an `OVSX_PAT`
secret. Keep the registered environment name identical to the workflow's
`environment` value so the repository's deployment restrictions apply.

After the workflow changes are on `main`, run **Actions → Publish Open VSX →
Run workflow**, select `main`, enter an existing published release tag and leave
**publish** unchecked. This checks the release package without uploading it; it
does not verify Open VSX credentials. Future GitHub release publications trigger
the upload automatically.

For a failed upload, inspect the job before retrying. Manually dispatch with the
same published tag and **publish** checked to retry Open VSX without rerunning
Marketplace. An existing version is an error; check the registry before retrying
an upload with an uncertain outcome. Verification-only runs check the artifact,
so actual OIDC publication is first exercised on the next unpublished version.

References: [Publishing extensions](https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions),
[Trusted publishing](https://blogs.eclipse.org/post/tamas-cservenak/trusted-publishing-open-vsx).

## One-time Marketplace identity setup

Use a Microsoft Entra tenant in which you can register applications. A personal
Microsoft account's shared Microsoft Services tenant is not a tenant you can
administer. The publishing workflow needs no Azure subscription or subscription
role: it uses `azure/login` with `allow-no-subscriptions: true` and receives its
publication permission from the Marketplace publisher.
If you do not have a tenant yet, complete Microsoft's
[Azure account/tenant onboarding](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-create-new-tenant)
first; its account, billing and eligibility requirements are separate from the
publishing workflow's permissions.

1. Register a single-tenant Entra application named `PyneIDE Marketplace`.
   Leave redirect URIs empty. Do not create a client secret or grant Microsoft
   Graph application permissions. Record its Application (client) ID and
   Directory (tenant) ID.
2. In **Certificates & secrets → Federated credentials → Add credential**,
   choose **Other issuer → Explicit subject identifier** and enter:

   | Field    | Value                                          |
   | -------- | ---------------------------------------------- |
   | Name     | `pyneide-marketplace`                          |
   | Issuer   | `https://token.actions.githubusercontent.com`  |
   | Subject  | `repo:PyneSys/PyneIDE:environment:marketplace` |
   | Audience | `api://AzureADTokenExchange`                   |

   These values match this repository's current default OIDC subject. Verify
   the repository's subject configuration before recreating the credential:
   newer GitHub/Entra setup screens can generate immutable-ID subjects instead.

3. Create the GitHub Actions environment `marketplace`. Allow deployments only
   from tags matching `v*`, plus branch `main` for manual verification/retry runs.
   To publish automatically after release publication, do not add a second
   required reviewer gate here. Add environment **variables** `AZURE_CLIENT_ID`
   and `AZURE_TENANT_ID` with the recorded IDs. They identify the app and tenant;
   no stored password or PAT is used.
4. Add the application to an Azure DevOps organization connected to the same
   Entra tenant, under **Organization settings → Users → Add users**. Select
   `PyneIDE Marketplace`, **Stakeholder** access and no project access. This
   creates the Azure DevOps profile needed by Marketplace. If creating a
   separate technical organization, keep it within the free tier. Without this
   step, the profile API can fail with `VSS011031: There is no profile for the
   authenticated user in the system` even though Entra sign-in succeeds.
5. Run **Actions → Publish Marketplace → Run workflow** on `main`, enter an
   existing published tag, and leave **publish** unchecked. This verifies the
   actual release package and signs in through Entra without uploading a version.
   The job summary records the Marketplace identity/profile ID. This ID is
   distinct from the Entra application ID and object IDs; the workflow obtains
   it as the signed-in service principal from the Azure DevOps profile API.
   On first setup, the publisher-access check can fail until the next step.
6. Add that identity/profile ID as **Contributor** under
   [PyneSys publisher → Members](https://marketplace.visualstudio.com/manage/publishers/pynesys).
7. Rerun the verification with **publish** unchecked. Confirm the publisher-access
   check now succeeds before publishing the next GitHub release.

After a transient publication failure, rerun the failed job, or manually dispatch
the workflow with the published tag and **publish** checked. Each Marketplace
version can be published only once; an already published version fails rather
than silently replacing its package. Check the Marketplace before retrying an
upload whose outcome is uncertain.

References: [Microsoft Entra publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace),
[GitHub federation setup](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust#github-actions),
[Azure DevOps application identities](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/service-principal-managed-identity?view=azure-devops),
[Azure Login without a subscription](https://github.com/Azure/login#login-without-subscription).
