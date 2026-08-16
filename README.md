# tca

A coding agent with a web UI, built to run on a phone under [Termux](https://termux.dev).
Zero runtime dependencies: `pkg install nodejs`, clone, run. No `npm install`, no
build step, no native modules to compile on the device.

The agent reads and writes files, searches code, and runs shell commands inside a
workspace directory. You drive it from the phone's browser.

It is meant to be as good as a desktop coding agent, not a cut-down one, within the
constraints a phone actually imposes. That means the things that decide whether an
agent is useful rather than the things that are easy to list:
[checking what it just wrote](#verification) so it finds out immediately when the
code does not compile, [delegating wide reading to sub-agents](#sub-agents) so a
long task does not fill the context window,
[summarising rather than truncating](#context) when it does, prompt caching because
a forty-step turn otherwise re-sends the whole history forty times, and a
[plan mode](#modes) so you can approve the approach before it spends your battery
on it.

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

The worse version of the same problem is when the interrupted upgrade takes *apt
itself* with it — `libapt-pkg` lands on a version needing `liblz4.so.1` while
`liblz4` does not, and from then on nothing can be installed, including the fix:

```
CANNOT LINK EXECUTABLE "apt": library "liblz4.so.1" not found
```

`install.sh` detects this before it does anything else, and again immediately after
the upgrade, which is where apt tends to kill itself. Then it repairs it, cheapest
first: usually only the soname symlink is missing and the versioned `.so` is still
there, which needs no network at all. Failing that it reads the repo's own
`Packages` index to find the exact `.deb` — no guessing at names or versions — and
places it with `dpkg`, which survives because it does not link `libapt-pkg`. Only
if both fail does it stop, and then it says to clear Termux's data and let the app
re-extract a fresh bootstrap.

That matters more than it sounds: the whole promise here is one command and then
`nhatnam`. An installer that can only report "apt is broken, go fix it yourself"
has already broken that promise.

For the same reason `git` is not on the critical path. If `git clone` fails - a
library mismatch on a freshly installed git, a missing CA bundle, a directory
already in the way - the installer prints git's actual error, says which of those
it looks like, and then falls back to fetching the tarball with curl, which is
demonstrably working because it is how the script itself arrived. git is only
needed to *update* later, not to install.

One of those causes is repaired rather than just reported. When the failure is in
git's https remote helper — `cannot locate symbol "curl_global_trace"` — git is
fine and `libcurl` is stale, so the installer reinstalls libcurl and clones again.
A device hit this and got the tarball instead: the install worked, but `~/tca` had
no `.git` and `tca update` was gone for good. Printing the right diagnosis and
then taking the lossy path anyway is not much better than printing the wrong one.

It installs every package the agent can use in one `apt-get` pass, clones into
`~/tca`, creates the `tca` and `nhatnam` commands, asks Android for storage
permission, sets up a service so the daemon survives being killed, and stops. It
asks nothing: the size is printed before the download starts, and the one thing
that genuinely needs a human — ADB pairing — is asked by `nhatnam` on first start,
where the pairing code is still on screen.

Then:

```sh
nhatnam
```

On the first run this asks whether to pair wireless ADB, because without it
Android kills the agent's child processes part way through a long task. Answer it
once; from then on the address is remembered and reconnected automatically. If
there is no terminal attached — Termux:Boot, a service — it skips the question
instead of hanging.

It prints a URL with an access token. Open it in Chrome on the phone:

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
tca run [--plan] "task"  one-shot turn in the terminal, no browser
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

Three rails, and the tests in `test/agent.test.mjs` and `test/verify.test.mjs`
cover all of them:

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
  the damage. Set `autoApproveEdits: false` (Settings → "Auto-approve file
  changes") and `write_file`, `edit_file`, `patch_file`, `move_file` and
  `delete_file` each ask first. Either way the tool output contains a diff of
  what changed, so you can see it after the fact.

[Plan mode](#modes) is the fourth rail when you want one: it removes the write tools
entirely rather than asking about them, and never auto-approves a command.

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
  | `adb`  | wireless debugging paired from the phone to itself | pairing does; the connection is remade for you |

  `tca serve` handles this at startup rather than leaving it to you to notice:

  1. If root or Shizuku is available, it applies the unlocks and says so.
  2. Otherwise it retries the last working `adb connect` address, saved in
     `~/.tca/adb.json` (mode `0600`, and only ever written after a connection is
     proven). This is the reboot case, and it costs no typing.
  3. Only if that fails does it ask whether to pair now, and drop into
     `tca adb-setup`. The question is gated on stdin being a terminal, so a start
     from Termux:Boot or a runit service never blocks on it — those fall back to
     picking up privileges in the background as they appear.

  Android hands out a new wireless-debugging port when the toggle is turned off
  and on, so a saved address can go stale; when it does, you get asked again.
  `tca adb-setup` remains the way to do all of this by hand.
- **Battery optimization** suspends the daemon seconds after screen-off. `tca serve`
  now takes a `termux-wake-lock` itself and releases it on exit, so this is no
  longer a step to forget. Set Termux to Unrestricted as well; Xiaomi, Samsung and
  Oppo need an extra autostart whitelist entry.
- **No systemd.** `install.sh` installs a runit service through `termux-services`.
  Note that runit starts from `~/.bashrc`, so after a reboot it only comes up once
  you open Termux; Android has no true boot service for unprivileged apps.
- **`which` is not there.** It is a program, not a shell builtin, and on Termux it
  came from `debianutils` — which dropped it in 5.x in favour of `command -v`. So
  on an up-to-date Termux there is no `which` at all, and anything that probed for
  a binary by spawning it got "not installed" for things sitting on `PATH`. This
  cost real time: the agent insisted `adb` was missing immediately after
  installing it, `tca doctor` reported ripgrep and jq absent, and `tca serve`
  silently stopped taking a wake lock. `findBinary()` in `src/privilege.js` walks
  `PATH` itself now — no subprocess, no dependency, same answer everywhere.
  `install.sh` never hit this because shell scripts can use the builtin.
- **`curl … | bash` makes the script its own stdin.** Everything the installer runs
  has `</dev/null` on it, and that is load-bearing. Bash reads a piped script
  lazily, so any command that reads stdin consumes the part not executed yet —
  and bash does not report that. It runs out of text and exits 0. On the device
  this printed `==> Tạo lệnh` and stopped: the last four steps simply gone, no
  error, no failing exit code, and *not on every run*, because how much gets eaten
  depends on buffering and how far curl has streamed. A test enforces the
  redirects, since the fix is 22 easy-to-forget characters guarding a silent
  failure. The generated `nhatnam` wrapper deliberately keeps its stdin — it has a
  question to ask.
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

`tca power` answers a different question from `doctor`: not "is anything broken"
but "what could this agent do here that it currently cannot". Each entry is
described by benefit rather than by package name, scored, and grouped into three
tiers so everything already working stays collapsed.

```sh
tca power
```

The catalogue is `src/capabilities.js`, and `install.sh` installs every package in
it in one `apt-get` call. A test checks the two lists against each other, because
the alternative — the table growing a package the installer never installs — is
what the web UI used to paper over with a per-item Install button.

That button, and the Power tab it lived in, are gone. Installing five things one
tap at a time was a bad way to spend a first run, and it left the agent's power
depending on whether you found the tab. One pass at install time is the whole
story now; `tca power` and `tca doctor` are read-only reports on the result.

The installer prints the real download size before it starts, taken from
`apt-get install -s` rather than numbers typed into the script. Roughly 600 MB of
that is `python` and the `clang` toolchain; set `TCA_SKIP_HEAVY=1` to leave them
out and keep the rest.

## Tools

Seventeen. The file tools are confined to the workspace; two reach the network.

```
read_file  batch_read  write_file  edit_file  patch_file  move_file  delete_file
list_dir   tree        glob        grep       run_command todo_write
read_url   web_search  task        verify
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

`task` delegates to a sub-agent — see [Sub-agents](#sub-agents). `verify` runs the
project's own checker on demand; writes already do it automatically, see
[Verification](#verification).

`grep` and `glob` both go through ripgrep when the device has it, and the
JavaScript walk when it does not. The two paths must return identical answers, or
the agent's behaviour would depend on which packages are installed, so
`src/fastsearch.js` overrides the defaults that disagree with ours (ripgrep reads
`.gitignore` and skips dotfiles; our walk does neither), gives a slash-free glob
`--max-depth 1` because gitignore semantics would otherwise match it at any depth
while minimatch keeps it in the current directory, and routes any pattern using
lookaround or backreferences - which the Rust regex crate cannot express - to
JavaScript instead. `TCA_NO_FASTSEARCH=1` forces the slow path, which is how the
parity test compares them.

Glob used to go through `fd`, and it disagreed with the walk in three independent
ways at once - ripgrep's exclusion flags passed to a tool where `--glob` is a
boolean switch, `--full-path` matching a `./`-prefixed platform-separated path, and
a basename match that recursed when it should not. Every one of them surfaced as
"no files match", which is the worst symptom available: indistinguishable from a
real empty result, so nothing fell back and the agent was told the file it was
looking for did not exist. `fd` is no longer used or installed.

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

## Verification

After every write the file that changed is run through whatever checker the
project already has, and the result is appended to the same tool result the agent
reads. `node --check`, `tsc --noEmit`, `ruff` (or `py_compile`), `gofmt -e`,
`bash -n`, and a JSON parse. Nothing to configure: a project that can be built has
already said how.

This closes the largest quality gap between a phone agent and a desktop one.
Without it the loop is *edit → "Done, I updated the handler." → the file does not
compile*, and the agent has no way to know, because nothing told it.

It is deliberately **not** a language server. tsserver on a phone costs hundreds of
megabytes of RAM, takes tens of seconds to index, and gets killed by Android's
low-memory killer mid-answer. Running the project's own checker on the one file
that changed gets most of the value for a fraction of the cost.

Two rules keep the output useful rather than overwhelming: errors in the file just
touched come first and pre-existing errors elsewhere are counted rather than
dumped, and a checker that times out says so — silence would read as "no errors",
which is the one wrong answer. Turn it off with `verifyEdits: false` if you are
working somewhere the checker is too slow.

Everything here spawns with an argv array and no shell. Quoting a model-supplied
path for a shell is a losing game across platforms; the first version did it and
produced `Cannot find module '"fine.mjs"'` on Windows, because cmd.exe and Node's
own argv escaping each quoted it once.

## Modes

`build` and `plan`, toggled next to Send. Plan mode withholds every file-writing
tool and never auto-approves a shell command, so the agent investigates and tells
you what it would change. `run_command` survives because reading a repository
properly needs `git log` and `git diff` — it just asks every time.

The mode is sent with the message rather than read from the config on the server:
the toggle and Send are one gesture, and a config write that has not landed yet
must not be what decides whether the agent can edit your files. It is enforced
twice — the tool specs are withheld, *and* the call is refused — because a model
that saw `write_file` earlier in the conversation can still ask for it.

Plan mode matters more on a phone than on a desktop. You want to approve the
approach before it spends half an hour of your battery on it.

## Sub-agents

The `task` tool runs a second agent with its own fresh context and hands back only
its final answer.

This is the right way to solve the context problem, and better than compaction at
it: a sub-agent that reads twenty files to answer "where is auth handled" costs the
parent one paragraph instead of twenty file dumps. Nothing it read enters the
parent's context, so it never has to be summarised away later.

Two kinds. `explore` is read-only and is the default. `general` can write, for work
that has to change files. Neither can spawn a sub-agent of its own — that is how one
tap turns into an unbounded fan-out of paid API calls. Their history lives in memory
and never touches the session file: it is scratch work, worth watching live and
worth nothing afterwards.

Their tool activity is streamed to the UI nested under the delegated task, open
while it runs. A phone user watching a two-minute sub-agent with nothing on screen
concludes the app has hung, and that is the bug people actually report.

## When a turn stops

A turn runs until the model stops asking for tools. There is no step budget and no
`maxSteps` setting — a cap has to be either low enough to cut off real work or high
enough to be no protection, and choosing the number means guessing about a task
only the user can see. The old default of 40 did the first thing: the failure was
a half-finished refactor and an error telling you to raise a number and start over.

What replaced it looks for the shape a stuck agent actually has. Each step is
fingerprinted by its tool calls *and* their results; three identical fingerprints
in a row ends the turn and says what was being repeated.

Both halves of that fingerprint carry weight:

- **Calls alone** would flag a legitimate poll — re-reading a file, re-running a
  build — as a loop, because those calls really are identical every time.
- **Results included** catches the case a step limit used to catch by accident: a
  tool failing the same way for ever. The model does not always change course, and
  without this there is nothing left to stop it before the credit runs out.

Changing arguments is progress, and a changing result is progress. Thirty rounds of
either is left alone.

## Context

Long sessions are summarised, not truncated. When the estimated prompt passes 75%
of the model's real context window, the older part of the history is handed to the
model to summarise and the summary is stored as a checkpoint, so it is produced
once rather than on every turn. The full transcript stays in the session file and
stays visible in the UI; only the model's view narrows.

Two rules make it safe:

- **Cuts only happen where no tool call is open.** Splitting a `tool_use` from its
  `tool_result` makes both APIs reject the request outright. The previous
  implementation cut by *message count* — keep the first 2 and the last 6 — which
  did exactly that, so every session past 30 messages died with a bare 400. Note
  that "no tool call is open" is a wider rule than "at a turn boundary", and
  deliberately: a single forty-step turn can overflow the window on its own, and it
  has to be possible to do something about that.
- **The summary comes from the model, not from `slice()`.** The old version
  truncated every message to 200 characters and dropped tool results entirely. The
  agent kept the knowledge that it had read five files and lost their contents,
  which is worse than not having read them: it stops re-reading because it believes
  it already knows.

`src/compact.js` also repairs a history left half-written by a killed process — the
normal case on Android, not the exotic one — by giving the unanswered calls a
synthetic "interrupted" result rather than refusing to continue the session.

Prompt caching is on by default where the provider supports it: breakpoints go on
the tool list, the system prompt, and the last two user turns, which is what makes
the cache *roll*. On a phone this is not a micro-optimisation — a forty-step turn
re-sends the whole history forty times, and without caching that is quadratic spend
on tokens the provider has already seen. The UI shows what came back from cache
next to the running cost.

## Layout

```
src/config.js        config resolution, ${ENV} expansion, key redaction
src/i18n.js          vi/en strings, read by Node and served to the browser
src/providers.js     30 probed providers: base URL, wire format, env vars
src/catalog.js       models.dev catalog: offline seed + optional full download
src/discover.js      live provider endpoint model discovery with 24h caching & fallback
src/recommended.js   curated shortlist
src/setup.js         env key detection, add provider, test connection
src/provider.js      the two wire formats, SSE, retries, cache breakpoints, thinking
src/compact.js       token estimation, safe cut points, history repair, summarising
src/exec.js          the only place that spawns a process; shell and argv forms
src/diagnostics.js   run the project's own checker on what was just written
src/tools.js         17 tools + workspace confinement + denylist + diff engine
src/fastsearch.js    ripgrep fast path for grep and glob, answer-for-answer with the walk
src/notify.js        termux-notification, so a blocked turn is not invisible
src/websearch.js     DuckDuckGo HTML search, selectors in one editable table
src/privilege.js     root / Shizuku / adb backends, and the Android unlocks
src/capabilities.js  what the agent could do here, scored and tiered
src/status.js        the `doctor` view of capabilities.js
src/store.js         sessions as JSONL, parse cache, compaction checkpoints
src/undo.js          turn-by-turn file undo/redo engine with SHA-256 hash verification
src/loop.js          the agent loop, sub-agents, cost accounting
src/daemon.js        HTTP + SSE + auth + static files
src/cli.js           serve / run / undo / redo / token / models / doctor / power / adb-setup
src/web/             the UI: no framework, zero build, modular ES modules
  app.js             root wiring, event dispatching, and mode switches
  helpers.js         DOM query/create helpers, i18n formatter, toasts
  state.js           central reactive app state container
  api.js             Bearer token management and SSE stream consumer
  markdown.js        zero-dependency markdown block parser & token highlighter
  components/        isolated components (chat, toolcard, approval, todopanel, sidebar, statusbar, settings, wizard)
install.sh           the one-command install, non-interactive
tools/gen-seed.mjs   regenerates the offline catalog
tools/drop-i18n-keys.mjs      removes i18n keys by name, line-accurately
tools/check-no-tty-start.mjs  starts the daemon with no TTY, checks it never asks
tools/check-fetch-source.sh   install.sh's libcurl repair and size report, against fakes
test/agent.test.mjs        end-to-end against a fake provider
test/capabilities.test.mjs capabilities, privileges, rish, i18n key parity, install.sh
test/context.test.mjs      pairing, repair, compaction, the store and checkpoints
test/discover.test.mjs     endpoint model discovery, format normalization, cache TTL
test/markdown.test.mjs     the UI renderer, highlighter and components, in a DOM stub
test/search.test.mjs       ripgrep parity for grep and glob, the plan tool, AGENTS.md
test/undo.test.mjs         turn-by-turn undo/redo, conflict detection, multi-turn rollback
test/verify.test.mjs       diagnostics, and the tool set each mode and agent gets
test/websearch.test.mjs    the search parser against a saved page, boot script
test/wire.test.mjs         what actually goes on the socket, for both formats
```

## Development

```sh
node --test test/*.test.mjs     # 168 tests, no network or API key needed
npx tsc --noEmit                # JSDoc types, on a dev machine only
node tools/gen-seed.mjs         # refresh the offline catalog from models.dev
```

Tests run the real daemon and the real agent loop against a fake local server
that speaks the OpenAI wire format, so they cover tool execution, approval
handling, sub-agents, auth and path confinement without spending tokens.

`wire.test.mjs` exists because a fake provider that accepts anything cannot catch
the bugs the real APIs reject: strict role alternation, `tool_result` ordering,
thinking blocks replayed without their signature. Every one of those arrives in
production as a bare 400 naming no cause. `context.test.mjs` asserts
`tool_use`/`tool_result` pairing directly, on the shapes that used to break it.

`markdown.test.mjs` loads the modular web scripts under `src/web/` into a small
DOM stub that has no `innerHTML` on it, so the renderer — including the syntax
highlighter — is pinned down and cannot quietly grow an XSS hole. It also checks
that every `id` and `t()` translation key requested across all web components
exists in `index.html` and `i18n.js`: nothing else catches that, because the stub
hands back an element for any id on purpose, and in a browser one missing id
throws and takes the rest of the script with it.

`capabilities.test.mjs` asserts that `vi` and `en` define exactly the same keys,
which is the only thing that stops a bilingual UI from rotting.

Types are JSDoc, checked with `tsc --noEmit` on a dev machine. There is no
TypeScript build: the phone runs the source as-is.

