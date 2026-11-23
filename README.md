# dsh-cross-bundle-drift

Answers one question cheaply: **are the installed bundles actually the commit they came from?**

GitHub publishes a blob sha per file in a commit; a local file has a git blob sha
(`sha1("blob " + size + "\0" + bytes)`). Comparing the two needs **one tree listing per bundle and
zero downloads** — useful on a link where reinstalling a 96 MB repo takes twenty minutes.

## Where it shows up

Not a settings page of its own. It registers one row on the **profile panel's feature slot board**
(`profileSlots`, published by `dsh-wb-profile`), and the panel renders it under "Panel features".
That is the split the project asks for: the panel owns placement and vocabulary, the cross owns the
fact.

```
GET /workbench/api/cross/bundle-drift            # { view: { lines }, report }
GET /workbench/api/cross/bundle-drift?refresh=1  # bypass the 90s cache
GET /workbench/api/cross/bundle-drift?only=<pkg>
```

## What the comparison is anchored to

- **Ref** — the commit pnpm resolved at install time, read out of `pnpm-lock.yaml` (both the
  `codeload…/tar.gz/<sha>` and the `git+https…#<sha>` spellings). Without that the check would
  compare against today's branch head and report drift that is only "upstream moved on".
  `refSource` says which it used: `lock`, `spec`, `default-branch`.
- **Scope** — the package's own `files` whitelist. A source repo legitimately carries `apps/`,
  `src/`, `tests/`, `native/`; an install never copies them. Counting those as "missing" would be
  noise, so they are reported as `outOfScope`.
- **Line endings** — a Windows checkout may hold CRLF where the repo stores LF. Both hashes count as
  a match; a match that needed normalization is reported as `lineEndingOnly`, because it is a
  checkout fact, not content drift.

Categories: `consistent`, `modified`, `missingLocal` (upstream has it, the install does not),
`localOnly` (build output such as `lib/`, usually gitignored upstream). Only `modified` and
`missingLocal` make a bundle dirty.

## Read-only

No install, no repair, no writes. Diagnosis stays diagnosis; repairing is a deliberate
`dsh plugin add`.
