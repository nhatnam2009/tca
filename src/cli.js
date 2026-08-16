#!/usr/bin/env node
/**
 * CLI entry point.
 *
 *   tca serve            start the daemon + web UI (default)
 *   tca run "..."        one-shot turn in the terminal, no browser
 *   tca token            print the URL with the access token
 *   tca models           show the recommended shortlist
 *   tca doctor           check the Termux/Android setup
 *   tca adb-setup        unlock Android limits via wireless ADB (Termux only)
 */

import os from "node:os";
import readline from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { serve, getToken } from "./daemon.js";
import { loadConfig, configPath, STATE_DIR } from "./config.js";
import { RECOMMENDED, TIERS } from "./recommended.js";
import { catalogInfo } from "./catalog.js";
import { seedFromEnv } from "./setup.js";
import { createSession } from "./store.js";
import { Runner } from "./loop.js";
import { getStatus, hasBinary } from "./status.js";

const [command = "serve", ...rest] = process.argv.slice(2);

switch (command) {
  case "serve":
    await cmdServe(rest);
    break;
  case "run":
    await cmdRun(rest.join(" "));
    break;
  case "token":
    cmdToken();
    break;
  case "models":
    cmdModels();
    break;
  case "doctor":
    cmdDoctor();
    break;
  case "adb-setup":
    await cmdAdbSetup();
    break;
  case "-h":
  case "--help":
  case "help":
    usage();
    break;
  case "-v":
  case "--version":
    console.log("0.1.0");
    break;
  default:
    console.error(`unknown command: ${command}\n`);
    usage();
    process.exit(1);
}

function usage() {
  console.log(`tca - coding agent with a web UI, built for Termux

  tca serve [--port N] [--host H]   start the daemon and print the UI URL
  tca run "task"                    one-shot turn in the terminal
  tca token                         print the URL including the access token
  tca models                        recommended models worth using
  tca doctor                        check this device's setup
  tca adb-setup                     unlock Android limits via wireless ADB

Config: ${configPath()}
State:  ${STATE_DIR}`);
}

async function cmdServe(args) {
  const port = numFlag(args, "--port");
  const hostIdx = args.indexOf("--host");
  const host = hostIdx !== -1 ? args[hostIdx + 1] : undefined;

  if (host && host !== "127.0.0.1" && host !== "localhost") {
    console.error(`REFUSING to bind ${host}.`);
    console.error("This agent can read and write your files and run shell commands.");
    console.error("Exposing it beyond loopback would let anything on the network do that too.");
    console.error("If you truly need remote access, put it behind SSH port forwarding instead:");
    console.error("  ssh -L 8787:127.0.0.1:8787 phone");
    process.exit(1);
  }

  const { added } = seedFromEnv();
  if (added.length) console.log(`Found API keys in the environment for: ${added.join(", ")}\n`);
  await serve({ port });
}

function cmdToken() {
  const { config } = loadConfig();
  const token = getToken();
  console.log(`http://127.0.0.1:${config.port || 8787}/?token=${token}`);
}

function cmdModels() {
  const info = catalogInfo();
  console.log(`Catalog: ${info.source} (${info.modelCount} tool-capable models, ${info.generated})\n`);
  for (const [tier, meta] of Object.entries(TIERS)) {
    console.log(`${meta.label} - ${meta.hint}`);
    for (const r of RECOMMENDED.filter((x) => x.tier === tier)) {
      console.log(`  ${r.provider}/${r.model || "(your local model)"}`);
      console.log(`      ${r.label}: ${r.why}`);
    }
    console.log("");
  }
  console.log("Pick one in the web UI Settings tab, or run: tca serve");
}

function cmdDoctor() {
  const { termux, checks } = getStatus();

  console.log(`tca doctor - ${os.platform()} ${os.arch()}\n`);
  console.log(termux ? `[- ] Termux ${process.env.TERMUX_VERSION}` : "[- ] Not running under Termux (Android checks skipped)");
  let problems = 0;
  for (const { ok, label, fix } of checks) {
    const mark = ok === null ? "-" : ok ? "ok" : "!!";
    console.log(`[${mark}] ${label}`);
    if (ok === false && fix) {
      problems++;
      for (const line of fix.split("\n")) console.log(`     ${line}`);
    }
  }
  console.log("");
  console.log(problems ? `${problems} thing(s) to fix.` : "Nothing blocking.");
  if (problems) process.exitCode = 1;
}

async function cmdRun(text) {
  if (!text.trim()) {
    console.error('usage: tca run "what you want done"');
    process.exit(1);
  }
  const { config } = loadConfig();
  if (!config.providers[config.active]) {
    console.error("No provider configured. Run `tca serve` and open Settings, or `tca models` for suggestions.");
    process.exit(1);
  }

  const { id } = createSession();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let streaming = false;

  const runner = new Runner({
    sessionId: id,
    config,
    emit: (ev) => {
      if (ev.type === "text_delta") {
        process.stdout.write(ev.text);
        streaming = true;
      } else if (ev.type === "tool_start") {
        if (streaming) process.stdout.write("\n");
        streaming = false;
        process.stdout.write(`  > ${ev.name} ${summarize(ev.input)}\n`);
      } else if (ev.type === "tool_end") {
        const first = (ev.output || "").split("\n")[0].slice(0, 100);
        process.stdout.write(`  ${ev.ok ? "<" : "x"} ${first}\n`);
      } else if (ev.type === "approval_request") {
        // handled below via the approve override
      } else if (ev.type === "error") {
        process.stderr.write(`\nerror: ${ev.message}\n`);
      } else if (ev.type === "done") {
        process.stdout.write("\n");
      }
    },
  });

  // Terminal approval instead of the web card.
  runner.approve = async ({ command, cwd, reason, kind = "command" }) => {
    const verb = kind === "edit" ? "allow this file change?" : "run this?";
    process.stdout.write(`\n  ${verb} ${command}\n  ${reason} (in ${cwd})\n`);
    const answer = (await rl.question("  [y/N] ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  };

  await runner.run(text);
  rl.close();
  console.log(`\nsession: ${id}`);
}

function summarize(input) {
  if (!input || typeof input !== "object") return "";
  const first = input.command || input.path || input.pattern || Object.values(input)[0];
  return String(first ?? "").slice(0, 120);
}

function numFlag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : undefined;
}

// ----------------------------------------------------------------- adb-setup

/**
 * Walk the user through wireless ADB pairing on Android 11+ (from within
 * Termux itself), then apply all the privilege unlocks a coding agent needs:
 *   - Phantom process limit raised to INT_MAX   (Android 12+ childkilling fix)
 *   - Termux whitelisted from Doze battery kill
 *   - Background activity + wake-lock ops allowed for com.termux
 */
async function cmdAdbSetup() {
  const termux = Boolean(process.env.TERMUX_VERSION);
  if (!termux) {
    console.error("tca adb-setup is only useful on Termux/Android.");
    console.error("On a PC, apply ADB commands directly from your desktop shell.");
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => rl.question(q);

  const c = {
    bold:   (s) => `\x1b[1m${s}\x1b[0m`,
    green:  (s) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    red:    (s) => `\x1b[31m${s}\x1b[0m`,
    cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  };

  const step = (n, msg) => console.log(`\n${c.bold(c.cyan(`[${n}]`))} ${c.bold(msg)}`);
  const ok   = (msg)    => console.log(`  ${c.green('[ok]')} ${msg}`);
  const warn = (msg)    => console.log(`  ${c.yellow('[!]')}  ${msg}`);
  const info = (msg)    => console.log(`       ${msg}`);

  const adbShell = (cmd) => {
    try {
      return { ok: true, out: execFileSync('adb', ['shell', cmd], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim() };
    } catch (e) {
      return { ok: false, out: e.stderr?.toString().trim() || e.message };
    }
  };

  console.log(c.bold('\n╔══════════════════════════════════════╗'));
  console.log(c.bold('║   TCA - Android ADB Privilege Setup  ║'));
  console.log(c.bold('╚══════════════════════════════════════╝\n'));
  console.log('Lệnh này kết nối ADB không dây từ chính điện thoại vào chính nó,');
  console.log('sau đó unlock các giới hạn Android ảnh hưởng đến coding agent.');

  // ── Step 1: Cài android-tools ──────────────────────────────────────────────
  step(1, 'Cài đặt android-tools (ADB) vào Termux');
  if (hasBinary('adb')) {
    ok(`ADB đã có: ${execFileSync('adb', ['version'], { encoding: 'utf8' }).split('\n')[0]}`);
  } else {
    console.log('  Đang cài pkg install android-tools ...');
    try {
      execFileSync('pkg', ['install', '-y', 'android-tools'], { stdio: 'inherit' });
      ok('android-tools đã cài xong');
    } catch {
      console.error(c.red('Cài thất bại. Thử tự cài: pkg install android-tools'));
      rl.close(); process.exit(1);
    }
  }

  // ── Step 2: Hướng dẫn bật Wireless Debugging ──────────────────────────────
  step(2, 'Bật Wireless Debugging trên điện thoại');
  console.log();
  info('Vào:  Cài đặt → Tùy chọn nhà phát triển → Gỡ lỗi không dây');
  info('(Nếu chưa mở Tùy chọn nhà phát triển: Cài đặt → Giới thiệu điện thoại → bấm');
  info(' vào "Số bản dựng" 7 lần)');
  info('');
  info('Sau khi bật, bạn sẽ thấy địa chỉ IP:Port ở màn hình Wireless Debugging.');
  await ask('  Nhấn Enter khi đã bật Wireless Debugging...');

  // ── Step 3: Pair bằng mã pairing ──────────────────────────────────────────
  step(3, 'Ghép nối (Pair) bằng mã');
  info('Trong màn hình Wireless Debugging → bấm "Ghép nối thiết bị bằng mã ghép nối"');
  info('Sẽ hiện ra:  IP:PORT   và   MÃ 6 SỐ');
  console.log();

  const pairAddr = (await ask('  Nhập IP:PORT ghép nối (vd: 192.168.1.5:38721): ')).trim();
  const pairCode = (await ask('  Nhập mã 6 số: ')).trim();

  if (!pairAddr || !pairCode) {
    console.error(c.red('Thiếu thông tin. Hủy.'));
    rl.close(); process.exit(1);
  }

  console.log('  Đang ghép nối...');
  try {
    execFileSync('adb', ['pair', pairAddr, pairCode], { stdio: 'inherit' });
    ok('Ghép nối thành công!');
  } catch {
    console.error(c.red('Ghép nối thất bại. Kiểm tra lại IP:PORT và mã.'));
    rl.close(); process.exit(1);
  }

  // ── Step 4: Kết nối ADB ───────────────────────────────────────────────────
  step(4, 'Kết nối ADB');
  info('Quay lại màn hình Wireless Debugging chính.');
  info('Bạn sẽ thấy một địa chỉ IP:PORT khác (cổng kết nối, khác cổng ghép nối).');
  console.log();

  const connAddr = (await ask('  Nhập IP:PORT kết nối: ')).trim();
  try {
    execFileSync('adb', ['connect', connAddr], { stdio: 'inherit' });
    ok(`Đã kết nối: ${connAddr}`);
  } catch {
    warn('Kết nối ADB có thể đã thành công dù có thông báo lỗi. Tiếp tục...');
  }

  // Kiểm tra devices
  const devices = execFileSync('adb', ['devices'], { encoding: 'utf8' });
  console.log('\n' + devices);

  // ── Step 5: Áp dụng các unlock ────────────────────────────────────────────
  step(5, 'Áp dụng Android privilege unlocks');
  console.log();

  const unlocks = [
    {
      label: 'Phantom process limit (Android 12+ childkill fix)',
      cmds: [
        '/system/bin/device_config set_sync_disabled_for_tests persistent',
        '/system/bin/device_config put activity_manager max_phantom_processes 2147483647',
      ],
    },
    {
      label: 'Termux vào whitelist Doze (ngăn Android tắt nền)',
      cmds: ['dumpsys deviceidle whitelist +com.termux'],
    },
    {
      label: 'Cho phép Termux chạy nền (RUN_IN_BACKGROUND)',
      cmds: ['cmd appops set com.termux RUN_IN_BACKGROUND allow'],
    },
    {
      label: 'Cho phép Termux giữ wake lock (WAKE_LOCK)',
      cmds: ['cmd appops set com.termux WAKE_LOCK allow'],
    },
    {
      label: 'Cho phép Termux chạy foreground service không giới hạn',
      cmds: ['cmd appops set com.termux START_FOREGROUND allow'],
    },
  ];

  let failed = 0;
  for (const { label, cmds } of unlocks) {
    process.stdout.write(`  ${label}... `);
    let allOk = true;
    for (const cmd of cmds) {
      const r = adbShell(cmd);
      if (!r.ok) { allOk = false; warn(`\n     Lỗi: ${r.out}`); }
    }
    if (allOk) { console.log(c.green('ok')); }
    else { failed++; }
  }

  // ── Step 6: Kết quả ───────────────────────────────────────────────────────
  console.log();
  if (failed === 0) {
    console.log(c.bold(c.green('✓ Tất cả unlock thành công!')));
    console.log();
    console.log('  Agent bây giờ có thể:');
    console.log('  - Tạo nhiều tiến trình con (shell commands) mà không bị Android kill');
    console.log('  - Chạy nền liên tục khi khoá màn hình (với termux-wake-lock)');
    console.log('  - Không bị Doze mode làm gián đoạn kết nối mạng');
    console.log();
    console.log('  Để các unlock giữ qua reboot, chạy lại lệnh này sau khi khởi động lại.');
    console.log('  (Thêm vào ~/.bashrc: alias tca-adb="tca adb-setup")');
  } else {
    warn(`${failed} unlock thất bại. Kiểm tra lại kết nối ADB và thử lại.`);
  }

  console.log();
  console.log('  Chạy tca doctor để kiểm tra tổng thể:');
  console.log(c.bold('    tca doctor'));

  rl.close();
}
