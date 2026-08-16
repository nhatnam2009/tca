# tca

A coding agent with a web UI, built to run on a phone under [Termux](https://termux.dev).
Zero runtime dependencies: `pkg install nodejs`, clone, run. No `npm install`, no
build step, no native modules to compile on the device.

The agent reads and writes files, searches code, and runs shell commands inside a
workspace directory. You drive it from the phone's browser.

## Install

On Termux, one command does everything (packages, the `tca` command, storage
permission, wake lock, health check, and optionally the ADB unlocks):

```sh
curl -fsSL https://raw.githubusercontent.com/nhatnam2009/tca/main/install.sh | bash
```

Or the smaller, non-interactive path, which also works on a desktop:

```sh
pkg install nodejs git
git clone https://github.com/nhatnam2009/tca.git ~/tca
cd ~/tca
bash setup.sh          # deps, storage permission, workspace, health check
node src/cli.js serve
```

Later, to update:

```sh
cd ~/tca && git pull
```

Both leave you with two commands: `tca` (the full CLI) and `nhatnam` (no
arguments = start the agent).

`serve` prints a URL with an access token. Open it in Chrome on the phone:

```
http://127.0.0.1:8787/?token=...
```

First run shows a setup wizard: pick a model, paste an API key, test the
connection. If an API key is already exported in your shell (`ANTHROPIC_API_KEY`,
`GROQ_API_KEY`, ...) it is detected and the wizard is skipped.

## Commands

```
tca serve            start the daemon and web UI
tca run "task"       one-shot turn in the terminal, no browser
tca token            reprint the URL with the token
tca models           the recommended model shortlist
tca doctor           check this device's setup
tca adb-setup        unlock the Android limits below over wireless ADB
```

(Without the shortcut installed: `node src/cli.js <command>`.)

## Providers

Model data comes from [models.dev](https://models.dev), the same catalog opencode
uses: 185 providers, 6583 models, of which 5551 can call tools. Only tool-capable
models are offered, because an agent that cannot call tools is useless.

Base URLs and wire formats live in `src/providers.js` â€” 30 providers, each probed
against its real endpoint. Two wire formats cover them:

- `anthropic` â†’ `POST {baseUrl}/v1/messages`
- `openai` â†’ `POST {baseUrl}/chat/completions` (~165 of the 185 providers, including
  Gemini through its OpenAI-compatible surface)

Anything not in the table works via the `other` provider: paste a base URL.

Three local runtimes are included for offline use: `llamacpp`, `ollama`,
`lmstudio`. Point one at your PC's LAN address to borrow a desktop GPU from the
phone. Their model lists are fetched live from `/v1/models` rather than typed by
hand.

A 58 KB offline seed catalog (254 models) ships in git so a fresh phone works
with no network. The full 3.8 MB models.dev dump is only downloaded if you tap
"Download full catalog" in Settings â€” never automatically, since mobile data is
usually metered.

`src/recommended.js` is a curated shortlist in the spirit of OpenCode Zen, since
5551 choices is not a choice. Every id and price in it is verified against
models.dev by `tools/gen-seed.mjs`, which fails the build if one goes stale.

## Config

Resolution order (`src/config.js`):

```
1. $TCA_CONFIG
2. ~/storage/shared/tca/config.json   ->  /sdcard/tca/config.json   (default on Termux)
3. ~/.tca/config.json                 (no storage permission, or desktop)
```

The default is shared storage on purpose: you can edit it with any Android text
editor, not just from the terminal. The web UI Settings tab writes the same file.

Anything with "All files access" can read `/sdcard`, so if you do not want a key
sitting there, write the env var instead and export it from `~/.bashrc`:

```json
{ "providers": { "anthropic": { "apiKey": "${ANTHROPIC_API_KEY}" } } }
```

Placeholders are expanded at load time and never written back to disk. Chat
history always stays in `~/.tca/sessions/`, never on `/sdcard` â€” it contains
whatever the agent read out of your files.

## Safety

Three rails, and the tests in `test/agent.test.mjs` cover all of them:

- **Workspace confinement.** Every tool path is resolved through `realpath` and
  must land inside `config.workspace`. Symlinks out of the tree fail.
- **Command denylist.** `rm -rf /`, `mkfs`, fork bombs, pipe-to-shell,
  `git push --force`, `git reset --hard` and friends are blocked even with
  auto-approve on. No setting turns this off.
- **Approval prompts.** With `autoApproveCommands: false` (the default) every
  shell command shows a card in the UI with Allow/Deny before it runs. A denial is
  reported back to the model as a tool error, so it adapts instead of crashing.
  If you never answer, the card expires after 10 minutes and says so; pressing
  Stop closes it too.
- **File changes** are allowed by default, because tapping Allow for every write
  on a phone makes the agent unusable and workspace confinement already bounds
  the damage. Set `autoApproveEdits: false` (Settings â†’ "Auto-approve file
  changes") and `write_file`, `edit_file`, `patch_file`, `move_file` and
  `delete_file` each ask first. Either way the tool output contains a diff of
  what changed, so you can see it after the fact.

Point `workspace` at a directory under git. Then a bad edit is one
`git checkout --` away, which is a better safety net than any prompt.

The daemon binds `127.0.0.1` only, and refuses any other host. That is necessary
but **not sufficient on Android**: the platform does not isolate localhost between
apps, so any installed app can reach the port. The bearer token is what actually
protects the agent, which is why even the static files require it. The token lives
in `~/.tca/token` (mode 600).

For remote access use SSH forwarding, not a wider bind:

```sh
ssh -L 8787:127.0.0.1:8787 phone
```

## Android gotchas

These cost more debugging time than anything in the code:

- **Phantom process killer (Android 12+)** caps an app at ~32 child processes and
  kills the excess. A coding agent spawns a shell per `run_command`, so long runs
  die at random. Easiest fix, run entirely on the phone:
  ```sh
  tca adb-setup      # pairs wireless ADB with itself, then applies the unlocks
  ```
  Or from a PC:
  ```sh
  adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent; \
    /system/bin/device_config put activity_manager max_phantom_processes 2147483647"
  ```
  Some devices reset it on reboot. `doctor` reports the current value when it can
  read it.
- **Battery optimization** suspends the daemon seconds after screen-off. Set
  Termux to Unrestricted, and use `termux-wake-lock` (the runit service does this
  for you). Xiaomi, Samsung and Oppo need an extra autostart whitelist entry.
- **No systemd.** `bash setup.sh --service` installs a runit service via
  `termux-services`. Note that runit starts from `~/.bashrc`, so after a reboot it
  only comes up once you open Termux; Android has no true boot service for
  unprivileged apps.
- **`/bin/sh` does not exist.** Termux keeps its userland in `$PREFIX` and the
  system shell is `/system/bin/sh`. `pickShell()` in `src/tools.js` probes for a
  real one.
- **Ports below 1024** are blocked without root.

## Tools

Thirteen, all confined to the workspace:

```
read_file  batch_read  write_file  edit_file  patch_file  move_file  delete_file
list_dir   tree        glob        grep       run_command read_url
```

`edit_file` replaces one exact string and refuses an ambiguous match.
`patch_file` applies a unified diff and refuses a stale one rather than
scrambling the file. `write_file`, `edit_file` and `patch_file` return a diff of
what they changed, coloured in the UI. Only `run_command` always asks for
approval; file changes ask only when `autoApproveEdits` is off.

## Layout

```
src/config.js        config resolution, ${ENV} expansion, key redaction
src/providers.js     30 probed providers: base URL, wire format, env vars
src/catalog.js       models.dev catalog: offline seed + optional full download
src/recommended.js   curated shortlist
src/setup.js         env key detection, add provider, test connection
src/provider.js      the two wire formats, SSE streaming, retries
src/tools.js         13 tools + workspace confinement + denylist + diff engine
src/store.js         sessions as JSONL
src/loop.js          the agent loop
src/daemon.js        HTTP + SSE + auth + static files
src/cli.js           serve / run / token / models / doctor / adb-setup
src/web/             the UI: no framework, no build
install.sh           one-shot Termux install (interactive)
setup.sh             minimal install, also works on a desktop
tools/gen-seed.mjs   regenerates the offline catalog
test/agent.test.mjs  end-to-end against a fake provider
test/markdown.test.mjs  the UI renderer, in a DOM stub
```

## Development

```sh
node --test test/*.test.mjs     # 38 tests, no network or API key needed
node tools/gen-seed.mjs         # refresh the offline catalog from models.dev
```

Tests run the real daemon and the real agent loop against a fake local server
that speaks the OpenAI wire format, so they cover tool execution, approval
handling, auth and path confinement without spending tokens. `markdown.test.mjs`
loads `src/web/app.js` into a small DOM stub that has no `innerHTML` on it, so
the renderer is pinned down and cannot quietly grow an XSS hole.

Types are JSDoc, checked with `tsc --noEmit` on a dev machine. There is no
TypeScript build: the phone runs the source as-is.
