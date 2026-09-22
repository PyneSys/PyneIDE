# Security Policy

PyneIDE runs code and handles credentials on your machine: it downloads and
manages a Python environment, spawns `uv`, `python`, `pyne` and `debugpy`,
stores a compile API key in the editor's SecretStorage, and talks to the
PyneSys compile service. Security reports about any of that are welcome.

## Reporting a vulnerability

Please **do not open a public issue** for a security report.

Use GitHub's private vulnerability reporting:
[Report a vulnerability](https://github.com/PyneSys/PyneIDE/security/advisories/new).

Please include:

- what an attacker can achieve, not only what looks wrong,
- the PyneIDE version and the editor + OS you reproduced it on,
- minimal steps to reproduce, and a sample workspace or script if relevant.

## Scope

In scope is everything shipped in this repository: the extension host code,
the Python bridge in `python/`, the chart webview, the managed environment
bootstrap, the plugin installer, and the problem reporter.

Out of scope here:

- **PyneCore** — report it at
  [PyneSys/pynecore](https://github.com/PyneSys/pynecore).
- **The compile service and the PyneSys websites** — server-side
  infrastructure rather than shipped code. Report those the same way and they
  will be routed on.
- A workspace that runs its own code when you run it. Running a Pyne or Pine
  script executes that script by design; PyneIDE declares
  `untrustedWorkspaces: false` for exactly this reason. Untrusted code doing
  what code does is not a vulnerability. Untrusted code running *without* a
  run action — e.g. on folder open, on editor activation, or through a setting
  that a workspace can silently override — is.

## Response

Reports are acknowledged as soon as possible. Fixes land on `main` and ship in
the next Marketplace release. Only the latest release receives security fixes.

There is no bug bounty. Reporters are credited by name in the release notes
unless they prefer to stay anonymous.
