# @local/dsh-xget

> [English](README.en.md) | [中文](README.md)

> Part of the [dsh-plugins](https://github.com/DoiiarX/dsh-plugins) collection — see that repository for the full index.

Xget acceleration injection plugin (host-level). Configure an xget mirror
instance on the settings page, and automatically inject acceleration proxy
environment variables for npm/npx, pip, and git commands.

## How it works

[xget](https://github.com/xixu-me/xget) is a developer-resource acceleration
engine — it rewrites the original URL into a mirror prefix (e.g.
`registry.npmjs.org/...` → `<instance>/npm/...`). This plugin registers a
middleware (owner = `xget`, set-mode same-owner replacement + disposer
self-cleanup) through the shell plugin's (`@local/dsh-shell-plugin`)
`shellMiddlewareSlot`, replacing execution on every bash run and injecting the
proxy environment variables:

| Tool | Environment variable | Effect |
| --- | --- | --- |
| npm / npx / yarn / pnpm | `NPM_CONFIG_REGISTRY=<instance>/npm/` | package install/download through the xget mirror |
| pip | `PIP_INDEX_URL=<instance>/pypi/simple/` | pip goes through the xget PyPI mirror |
| git | `GIT_CONFIG_*` (`url.<instance>/gh/.insteadOf` etc., 8 rules) | `git clone https://github.com/...` etc. auto-rewritten to xget |
| Go | `GOPROXY=<instance>/golang,direct` + `GOSUMDB=off` | `go get` / `go mod download` through xget |
| Hugging Face | `HF_ENDPOINT=<instance>/hf` | huggingface_hub model/dataset download through xget |

## Configuration (settings page: Xget acceleration)

- `enabled`: global switch (default true)
- `instance`: xget instance URL (default `https://xget.doiiars.com`)
- `npm` / `pypi` / `git` / `go` / `huggingface`: per-platform switches

## Model tool

- `xget_set`: the model can query/enable/disable xget acceleration for the
  current session (session-level override, takes precedence over the global
  switch).

## Dependencies

- `@local/dsh-shell-plugin` (provides `shellMiddlewareSlot` and the bash tool)
- host `settings` service

## Notes

- Middleware cannot rewrite the frozen `args.command` (tools registry
  deepFreeze), so it replaces execution instead: spawns its own process and
  merges the proxy env into the child.
- On plugin upgrade, set-mode same-owner registration replaces the old
  middleware and the disposer cleans up on unload — no stale version remains.
- **git push exemption**: git's `insteadOf` rewrites both fetch and push, which
  would hijack `git push` to the xget mirror (self-hosted instances usually
  have no push credentials, so it fails verification). This plugin therefore
  skips git insteadOf injection for `git push` commands and only accelerates
  pull operations like clone/pull/fetch/ls-remote; npm/pip/go/hf injection is
  unaffected.
