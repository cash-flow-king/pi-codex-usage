# pi-codex-usage

> Minimal zero-configuration Pi extension for showing primary ChatGPT Codex usage limits in the statusline

![Codex Usage](./banner.jpg)

This repository is a minimal fork of [`narumiruna/pi-extensions/extensions/pi-codex-usage`](https://github.com/narumiruna/pi-extensions/tree/main/extensions/pi-codex-usage). It keeps the auth and quota-fetching path, but intentionally narrows the interface to the Codex quota windows returned by OpenAI.

## Start Here

- [Agent Notes](./AGENTS.md)
- [Backlog](./BACKLOG.md)
- [Changelog](./CHANGELOG.md)

## Features

- Shows two counter-moving half-height markers in the statusline bar while Codex usage is loading, then keeps the bar fresh (the countdown ticks locally)
- Keeps the last usable bar visible during ordinary refreshes instead of replacing known quota with a loading state
- Statusline output adapts to the response: weekly-only limits show an explicit remaining percentage and reset countdown, while dual-window limits keep the compact themed bar
- All Codex subscription models share the primary `codex` quota and status label
- When `pi-telegram` is available, the same compact value appears as `codex: <value>` in the `/start` menu status text for active OpenAI Codex subscription models
- Additional returned quota buckets are ignored
- Pi OpenAI Codex provider auth is used first
- Codex CLI app-server remains available as a fallback
- Missing auth, subscription, plan, or quota windows are shown as `n/a`, not as an error
- Successful updates briefly redraw the bar only when a 5% segment changes
- Network/provider failures keep the last good bar (up to an hour), then show `error`
- Any number of Pi instances share one request stream, see [Shared Refresh](#shared-refresh)
- No commands or configuration are required

## Install

From npm:

```bash
pi install npm:@llblab/pi-codex-usage
```

From git:

```bash
pi install git:github.com/llblab/pi-codex-usage
```

## Statusline

Regular Codex usage:

```text
codex ██████▀▀▀▀ 6d
```

When OpenAI returns only the weekly window, the status shows the exact rounded remaining percentage and reset countdown directly:

```text
codex 67% 7d
```

When both windows exist, the ten-character bar encodes two twenty-step limits at once: the top quadrants show the 5-hour limit and the bottom quadrants show the weekly limit, with each step representing 5%. If either quota window is exhausted, the bar keeps its shape but switches to the error background color.

Before the first usable Codex report arrives, two half-height markers move through the same fixed-width themed bar. The upper 5-hour marker travels opposite the lower weekly marker; both reverse smoothly at the ends, and each loader run randomly starts from one of the two mirrored endpoint phases. Their motion distinguishes loading from 100% remaining quota while preserving the normal bar background. A first report claiming both windows are completely unused is treated as provisional for 15 seconds and retried every second by the refreshing instance before it is published, because providers can briefly emit zeroed windows while initializing. Once a usable report exists, refresh requests preserve that last good bar.

When the weekly reset time is available, it follows either the single-window percentage or the dual-window bar. More than a day remains is shown in 144-minute day-tenth steps such as `7d`, `6.9d`, `6.6d`, `5.1d`, `5d`, `3.7d`, `3d`, `2d`, `1.9d`, `1.5d`, and `1.1d`, rounded upward to the next tenth. At 24 hours and below it switches to upward-rounded 6-minute hour-tenth steps such as `24h`, `23.7h`, `20.1h`, `20h`, `19.9h`, `1.4h`, `1.3h`, `1.2h`, `1.1h`, and `1h`. Under an hour it switches to floored minutes, and under a minute to seconds. After the reset timestamp passes, `0s` is held until the next successful quota refresh reports the new weekly window.

Business accounts that return credits instead of Codex rate-limit windows show the rounded remaining percentage. When the response includes a credit reset cycle, its countdown is shown after the percentage:

```text
codex 81% 2.8d
```

When the 5-hour window is exhausted and exposes its own reset time, the statusline adds the 5-hour reset before the weekly reset:

```text
codex ▄▄▄▄▄⠀⠀⠀⠀⠀ 5h/7d
```

The ten-character dual bar stays unchanged. The first countdown is the 5-hour reset, and the second countdown after `/` is the weekly reset.

Unavailable because Codex auth or subscription quota is not available:

```text
codex n/a
```

Runtime failure, such as a network or provider error:

```text
codex error
```

## Shared Refresh

The coordination code lives in the `Shared Refresh` section of [`index.ts`](./index.ts); the extension ships as a single TypeScript source file.

All Codex models and instances coordinate through `~/.pi/agent/tmp/pi-codex-usage/usage.json` (quota percentages and timestamps only, no tokens). The Claude extension uses its own independent file at `~/.pi/agent/tmp/pi-claude-usage/usage.json`.

Previous per-bucket cache directories are no longer read or written; there is no migration. Restart all previously running instances when upgrading to stop them writing the old layout.

- The instance that last updated the file is the leader and refreshes it every minute
- Every other instance only reads the file (re-checking every ≤30s) and redraws when it changes
- Leadership is never cached in memory: before each usage request (including retries and fallbacks), the instance re-reads the file and checks its `owner`, unique `claimId`, and 90s lease. Publication rechecks that claim under the lock; a superseded success or failure is discarded. Failed locks or unwritten claims never authorize a request
- If the file is 90 seconds old (leader is closed, busy, or asleep), the first follower that obtains the mutex takes over: it re-reads the JSON, writes itself as the leader with a fresh timestamp, releases the mutex, then fetches from the server and publishes under the mutex after rechecking its claim. Its next refresh is one minute later; JSON writes remain atomic renames
- Claiming and publication use a non-waiting transaction in `mutex.sqlite`, through Node's built-in `node:sqlite` (Node ≥22.19.0, the existing package minimum). It stores no quota or leadership records and needs no extra package or service. The OS releases the lock when the connection closes or the process dies; there is no timeout-based lock stealing
- Failures are written to the file with an exponential backoff (1 to 5 minutes; 5 to 30 minutes on HTTP 429) that applies to all instances
- Instances without data yet show the loading bar and re-check every second until the leader publishes

Coordination assumes a local filesystem and cooperating instances on the same machine. Never delete or replace `mutex.sqlite` while instances are running. Network requests do not hold the mutex; a process paused inside a short critical section keeps it until it resumes or exits, so other writers retry later without blocking the TUI. This preserves exclusion instead of stealing a live lock.

**Upgrade:** Close all old instances before starting updated ones. The legacy `lock` files are ignored; old and new locking protocols must not run together. Cached `usage.json` data needs no migration.

## Telegram Status Menu

If `@llblab/pi-telegram` is loaded with the public status-line provider API, this extension registers an optional `/start` menu status row. The row is shown only while the active model uses the OpenAI Codex subscription provider:

```text
codex: ██████▀▀▀▀ 6d
```

The value is the same compact quota bar plus weekly reset countdown used by the terminal statusline, always with the `codex` label. If `pi-telegram` is absent, older, or the active model is not a Codex subscription model, no Telegram row is added.

## Auth

The extension tries usage sources in this order:

1. Pi's `openai-codex` provider auth
2. `codex app-server --listen stdio://`

OpenAI API keys are not ChatGPT Codex subscription auth and do not expose these quotas.

## License

MIT. See [`LICENSE`](./LICENSE).
