# tca

A coding agent with a web UI, built to run on a phone under [Termux](https://termux.dev).
Zero runtime dependencies: `pkg install nodejs`, clone, run. No `npm install`, no
build step, no native modules to compile on the device.

The agent reads and writes files, searches code, and runs shell commands inside a
workspace directory. You drive it from the phone's browser.

## Install

One command, on a fresh Termux, start to finish:

```sh
curl -fsSL https://raw.githubusercontent.com/nhatnam2009/tca/main/install.sh | bash
```

**Do not run `pkg install curl` first.** Termux ships with curl, and installing any
single package on a system that is behind pulls a build linked against newer
shared libraries than the rest of the system, which breaks that binary
immediately:

```
CANNOT LINK EXECUTABLE "curl": cannot locate symbol "nghttp2_option_set_..."
```

That is Termux's cardinal rule: upgrade everything, then install. `install.sh` does
them in that order. If you have already hit it, repair with:

```sh
pkg upgrade -y -o Dpkg::Options::=--force-confold
```

It installs the packages, clones into `~/tca`, creates the `tca` and `nhatnam`
commands, asks Android for storage permission, sets up a service so the daemon
survives being killed, and stops. It asks no questions: everything interactive
(ADB pairing, Shizuku, picking a model) lives in the web UI instead, because
tapping a button on a phone beats typing a command into a terminal.

Then:

```sh
nhatnam
```

That prints a URL with an access token. Open it in Chrome on the phone:

```
http://127.0.0.1:8787/?token=...
```

First run shows a setup wizard: pick a model, paste an API key, test the
connection. If an API key is already exported in your shell (`ANTHROPIC_API_KEY`,
`GROQ_API_KEY`, ...) it is detected and the wizard is skipped.

On a desktop the same script works and skips the Android parts:

```sh
git clone https://github.com/nhatnam2009/tca.git
cd tca && bash install.sh
tca serve
```

To update later:

```sh
cd ~/tca && git pull
```

## Commands

```
tca serve            start the daemon and web UI
tca run "task"       one-shot turn in the terminal, no browser
tca token            reprint the URL with the token
tca models           the recommended model shortlist
tca doctor           check this device's setup
tca power            what the agent can do here, and what is missing
tca adb-setup        grant Android privileges (root / Shizuku / wireless ADB)
```

`nhatnam` with no arguments is `tca serve`; with arguments it forwards them, so
`nhatnam power` works too.

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
protects the agent. It lives in `~/.tca/token` (mode 600).

The static shell (`index.html`, `app.js`, `style.css`, `i18n.json`) is served
without a token, because it is the public source of this project and because the
page whose whole job is to ask for a token has to be reachable to ask for it.
Every `/api/*` route demands an explicit token in a header or the query string.
There is no auth cookie, so no ambient credential exists and there is no CSRF
surface.

For remote access use SSH forwarding, not a wider bind:

```sh
ssh -L 8787:127.0.0.1:8787 phone
```

## Android gotchas

These cost more debugging time than anything in the code:

- **Phantom process killer (Android 12+)** caps an app at ~32 child processes and
  kills the excess. A coding agent spawns a shell per `run_command`, so long runs
  die at random. This is the single most important thing to fix on a modern phone.

  There is more than one way to get the privilege to fix it, and `src/privilege.js`
  tries them best-first rather than assuming ADB:

  | backend | needs | survives reboot |
  |---|---|---|
  | `root` | `su` | yes |
  | `rish` | the Shizuku app, plus its `rish` files copied into `~` | pairing does; restart the app |
  | `adb`  | wireless debugging paired from the phone to itself | no, pair again |

  Run `tca adb-setup`, or use the Power tab in the web UI, which drives the same
  functions. `tca serve` re-applies the unlocks on every start, because wireless
  ADB pairing is lost on reboot and the failure is otherwise invisible.
- **Battery optimization** suspends the daemon seconds after screen-off. `tca serve`
  now takes a `termux-wake-lock` itself and releases it on exit, so this is no
  longer a step to forget. Set Termux to Unrestricted as well; Xiaomi, Samsung and
  Oppo need an extra autostart whitelist entry.
- **No systemd.** `install.sh` installs a runit service through `termux-services`.
  Note that runit starts from `~/.bashrc`, so after a reboot it only comes up once
  you open Termux; Android has no true boot service for unprivileged apps.
- **`/bin/sh` does not exist.** Termux keeps its userland in `$PREFIX` and the
  system shell is `/system/bin/sh`. `pickShell()` in `src/tools.js` probes for a
  real one.
- **Ports below 1024** are blocked without root.
- **Never install one package onto a stale system.** This is the failure that costs
  the most time, because the binary appears to install fine and then will not run:
  ```
  CANNOT LINK EXECUTABLE "curl": cannot locate symbol "nghttp2_option_set_..."
  ```
  A single `pkg install X` fetches the current build of X, linked against library
  versions newer than the ones you have. `pkg upgrade` first, always. `install.sh`
  does the full upgrade before installing anything, and checks that `curl`, `git`
  and `node` actually *run* rather than only that they exist, so this is reported
  as what it is instead of surfacing later as something else.

## Capabilities

`tca power` (and the Power tab) answers a different question from `doctor`: not
"is anything broken" but "what could this agent do here that it currently cannot".
Each entry is described by benefit rather than by package name, scored, and
grouped into three tiers so everything already working stays collapsed.

```sh
tca power
```

The catalogue is `src/capabilities.js`. It is also the allowlist for the install
endpoint: the browser sends a capability id, never a package name, and apt is
invoked with an argv array under `--force-confold` (there is no terminal behind an
HTTP request, so a dpkg conffile prompt would hang it forever).

The Power tab drives the same functions as `tca adb-setup`, and the wireless
pairing flow is genuinely better there than in the terminal: the address and the
6-digit code can be pasted straight off the Android settings screen instead of
typed digit by digit.

## Tools

Fifteen. The file tools are confined to the workspace; two reach the network.

```
read_file  batch_read  write_file  edit_file  patch_file  move_file  delete_file
list_dir   tree        glob        grep       run_command todo_write
read_url   web_search
```

`edit_file` replaces one exact string and refuses an ambiguous match.
`patch_file` applies a unified diff and refuses a stale one rather than
scrambling the file. `write_file`, `edit_file` and `patch_file` return a diff of
what they changed, coloured in the UI. Only `run_command` always asks for
approval; file changes ask only when `autoApproveEdits` is off.

`todo_write` is the agent's checklist for the current task. It is stored per
session under `~/.tca/todos/`, never in your workspace, and is re-injected into
the system prompt every turn so history compaction cannot lose the plan halfway
through a long job. The UI renders it as one card that updates in place.

`grep` and `glob` use ripgrep and fd when the device has them, and the JavaScript
walk when it does not. The two paths must return identical answers, or the agent's
behaviour would depend on which packages are installed, so `src/fastsearch.js`
overrides the defaults that disagree with ours (ripgrep reads `.gitignore` and
skips dotfiles; our walk does neither) and routes any pattern using lookaround or
backreferences - which the Rust regex crate cannot express - to JavaScript
instead. `TCA_NO_FASTSEARCH=1` forces the slow path, which is how the parity test
compares them.

If the workspace contains an `AGENTS.md`, it is read on every turn and appended to
the system prompt. That is the cheapest way to teach the agent "this project uses
pnpm" or "never touch generated/".

`web_search` closes a real ceiling: the agent could fetch a URL but had no way to
find one, so it could not look up an API it did not already know. It goes through
DuckDuckGo's HTML page, which needs no API key and no account. That is scraping,
and it is honest about it: every selector is a named constant in `src/websearch.js`,
the tests pin the page shape against a saved fixture, and an unreadable page
reports "the HTML has probably changed" rather than "no results" - because those
need completely different responses from a human.

## Layout

```
src/config.js        config resolution, ${ENV} expansion, key redaction
src/i18n.js          vi/en strings, read by Node and served to the browser
src/providers.js     30 probed providers: base URL, wire format, env vars
src/catalog.js       models.dev catalog: offline seed + optional full download
src/recommended.js   curated shortlist
src/setup.js         env key detection, add provider, test connection
src/provider.js      the two wire formats, SSE streaming, retries
src/tools.js         14 tools + workspace confinement + denylist + diff engine
src/fastsearch.js    ripgrep/fd fast path, kept answer-for-answer with the walk
src/notify.js        termux-notification, so a blocked turn is not invisible
src/websearch.js     DuckDuckGo HTML search, selectors in one editable table
src/privilege.js     root / Shizuku / adb backends, and the Android unlocks
src/capabilities.js  what the agent could do here, scored and tiered
src/status.js        the `doctor` view of capabilities.js
src/store.js         sessions as JSONL
src/loop.js          the agent loop
src/daemon.js        HTTP + SSE + auth + static files
src/cli.js           serve / run / token / models / doctor / power / adb-setup
src/web/             the UI: no framework, no build
install.sh           the one-command install, non-interactive
tools/gen-seed.mjs   regenerates the offline catalog
test/agent.test.mjs        end-to-end against a fake provider
test/capabilities.test.mjs capabilities, privileges, rish, i18n key parity
test/markdown.test.mjs     the UI renderer and the Power panel, in a DOM stub
test/search.test.mjs       ripgrep/fd parity, the plan tool, AGENTS.md
test/websearch.test.mjs    the search parser against a saved page, boot script
```

## Development

```sh
node --test test/*.test.mjs     # 89 tests, no network or API key needed
node tools/gen-seed.mjs         # refresh the offline catalog from models.dev
```

Tests run the real daemon and the real agent loop against a fake local server
that speaks the OpenAI wire format, so they cover tool execution, approval
handling, auth and path confinement without spending tokens. `markdown.test.mjs`
loads `src/web/app.js` into a small DOM stub that has no `innerHTML` on it, so
the renderer is pinned down and cannot quietly grow an XSS hole.
`capabilities.test.mjs` asserts that `vi` and `en` define exactly the same keys,
which is the only thing that stops a bilingual UI from rotting.

Types are JSDoc, checked with `tsc --noEmit` on a dev machine. There is no
TypeScript build: the phone runs the source as-is.
