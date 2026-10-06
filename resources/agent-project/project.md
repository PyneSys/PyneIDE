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

## Pine source ownership

Choose the workflow from the files for the script being changed, using the same directory
and filename stem (for example, `signal.pine` and `signal.py`):

- Only `signal.pine` exists: use the Pine workflow. Edit it and let the IDE create its outputs.
- Both `signal.pine` and `signal.py` exist: use the Pine workflow. Edit only `signal.pine`;
  the matching Python file is a compiled companion for this workflow.
- Only `signal.py` exists, without a matching `signal.pine`: use the Pyne workflow and edit
  that Python source normally. Other Pine files with different names do not change this choice.

**For a task on a `.pine` file, edit only the Pine source.** Treat its compiler-generated
`.py` and `.py.map` companions as read-only. Do not modify, synchronize, delete or recreate
them to match your Pine edits. Reading generated code for diagnosis is fine; apply the fix
to the `.pine` file and let PyneIDE update the outputs through Compile, Run or Debug.

Manual edits to generated Python change the output hash recorded by the IDE. When it next
compiles the Pine source, it warns that the Python file may contain manual edits and asks
whether to overwrite it. Avoid that interruption by leaving generated outputs untouched.

Pyne `.py` source without a matching `.pine` remains editable. Change compiler-generated
outputs only when the user explicitly requests that separate task.

Keep user preferences and existing source files when refreshing the project.
Report the runtime or chart checks actually performed.
