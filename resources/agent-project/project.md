## PyneIDE project

This is a Pine Script and Pyne development project initialized by PyneIDE.
Read `AGENT_RULES.md`, when present, before changing code. Those development preferences apply
alongside the IDE's technical guidance; keep both when working on this project.
If the file contains only starter guidance, use the project defaults and leave it unchanged.

| Task                                        | Skill                 |
| ------------------------------------------- | --------------------- |
| Write, repair or migrate Pine Script        | `pine-development`    |
| Write or repair Pyne code and libraries     | `pyne-development`    |
| Run, debug, inspect data or verify charts   | `pyneide-workflow`    |

Use the skill with that name discovered by your agent host. If it is not in the
host's skill list, read `.agents/skills/<skill-name>/SKILL.md` directly and follow
its relevant references. Claude and Cursor also have copies in their native
skill directories.

Each skill's `references/project.json` records the actual workdir, interpreter,
CLI and bundled PyneCore documentation paths. The workdir can be this folder or
its `workdir/` subfolder. Read the local PyneCore documentation without a network
request; use the Pine skill's topic index for external Pine references.

When a `.pine` file and its generated `.py` coexist, edit the Pine source for a
Pine task. Keep user preferences and existing source files when refreshing the
project. Report the runtime or chart checks actually performed.
