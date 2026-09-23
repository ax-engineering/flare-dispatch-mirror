# flare-dispatch-mirror

A read-only mirror of the upstream [FlareDispatch](https://github.com/fractalboxdev/flare-dispatch) repository (MIT). Nothing is developed here.

## Layout

| Branch | Contents |
| --- | --- |
| `mirror-ops` (default) | This README and the sync workflow. The only branch this org writes by hand. |
| `upstream-main` | Upstream's `main`, force-pushed verbatim. Commit SHAs are identical to upstream's. |

Consumers pin a commit SHA, so a pin resolves here exactly as it does upstream:

```yaml
uses: ax-engineering/flare-dispatch-mirror/actions/flare-dispatch-action@<sha>
```

## Why it exists

`ax-engineering/core` deploys a FlareDispatch Dispatcher from a pinned upstream SHA and calls two composite actions from the same tree. The mirror guarantees that code stays reachable from this org if upstream is deleted, renamed, or archived — which has already happened once to an earlier upstream home.

The mirror never diverges. A fix lands upstream and arrives here on the next sync; consuming it is still a one-line SHA bump in the consumer repo.

## Syncing

`.github/workflows/sync-upstream.yml` runs daily at 04:00 UTC and on demand. It fetches upstream `main` and force-pushes it to `upstream-main` over SSH, using a repo-scoped deploy key (`MIRROR_SSH_KEY`). SSH is required: the `GITHUB_TOKEN` is refused when a push carries `.github/workflows` changes, and upstream's tree contains them.

A sync only ever moves `upstream-main`. It never touches `mirror-ops`.

## Reporting a bug

Open it upstream. Issues filed here reach nobody who can fix them.
