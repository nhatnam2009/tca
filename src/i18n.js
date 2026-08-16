/**
 * Translations, in one place.
 *
 * Both sides of the app read this file:
 *   - Node imports it directly (`tca doctor`, capabilities, status);
 *   - the browser fetches it as JSON from GET /assets/i18n.json, because
 *     src/web/app.js is a classic script and cannot `import`.
 *
 * That is the whole point: the terminal and the web UI can never drift into
 * saying different things about the same check.
 *
 * Rules for adding a string:
 *   - every key must exist in BOTH `vi` and `en` (there is a test for it);
 *   - keys are flat and dotted, grouped by area: `cap.*`, `priv.*`, `status.*`;
 *   - placeholders are {name}, filled by t(lang, key, { name: ... }).
 */

/** @typedef {"vi" | "en"} Lang */

export const LANGS = /** @type {Lang[]} */ (["vi", "en"]);
export const DEFAULT_LANG = "vi";

export const DICT = {
  vi: {
    // ---------------------------------------------------------------- tiers
    "tier.required": "Cần thiết",
    "tier.recommended": "Nên có",
    "tier.advanced": "Nâng cao",
    "tier.required.hint": "Thiếu những thứ này thì agent không chạy được.",
    "tier.recommended.hint": "Nhẹ, và tăng sức mạnh agent rõ rệt.",
    "tier.advanced.hint": "Nặng hơn. Chỉ cài khi bạn cần.",

    // ------------------------------------------------------------ chung
    "common.installed": "Đã có",
    "common.missing": "Chưa có",
    "common.unknown": "Chưa rõ",
    "common.install": "Cài ngay",
    "common.installing": "Đang cài…",
    "common.recheck": "Kiểm tra lại",
    "common.size": "{n} MB",
    "common.package": "gói {name}",

    // ------------------------------------------------------- năng lực
    "cap.node.title": "Node.js",
    "cap.node.why": "Toàn bộ agent chạy trên Node. Cần bản 20 trở lên.",
    "cap.node.fix": "Chạy: pkg install nodejs",

    "cap.provider.title": "Model đã kết nối",
    "cap.provider.why": "Chưa có model thì agent không thể suy nghĩ.",
    "cap.provider.fix": "Vào tab Cài đặt để thêm provider và API key.",

    "cap.workspace.title": "Thư mục làm việc",
    "cap.workspace.why": "Agent chỉ được đọc và ghi bên trong thư mục này.",
    "cap.workspace.fix": "Tạo nó: mkdir -p {path}",

    "cap.shell.title": "Shell",
    "cap.shell.why": "Không có shell thì agent không chạy được lệnh nào.",
    "cap.shell.fix": "Chạy: pkg install bash",

    "cap.git.title": "Git",
    "cap.git.why": "Để agent xem thay đổi, commit, và bạn quay lại được khi nó sửa sai.",
    "cap.git.fix": "Chạy: pkg install git",

    "cap.fast_search.title": "Tìm code nhanh hơn nhiều lần",
    "cap.fast_search.why":
      "Không có ripgrep, tool grep phải tự đọc từng file bằng JavaScript. Repo vài nghìn file trên điện thoại sẽ mất vài giây mỗi lần tìm.",
    "cap.fast_search.fix": "Chạy: pkg install ripgrep",

    "cap.fast_glob.title": "Liệt kê file nhanh hơn",
    "cap.fast_glob.why": "fd làm tool glob nhanh hơn và bỏ qua .gitignore đúng cách.",
    "cap.fast_glob.fix": "Chạy: pkg install fd",

    "cap.notifications.title": "Thông báo khi agent xong việc",
    "cap.notifications.why":
      "Trên điện thoại bạn chuyển app liên tục. Không có cái này thì bạn không biết agent đã xong hay đang chờ bạn duyệt lệnh.",
    "cap.notifications.fix": "Chạy: pkg install termux-api — và cài thêm app Termux:API từ F-Droid.",

    "cap.storage.title": "Quyền truy cập bộ nhớ",
    "cap.storage.why": "Để sửa config.json bằng bất kỳ app soạn thảo nào, và làm việc với file trong Download.",
    "cap.storage.fix": "Chạy: termux-setup-storage rồi bấm Cho phép.",

    "cap.wake_lock.title": "Chống Android ngắt khi tắt màn hình",
    "cap.wake_lock.why":
      "Không giữ wake lock thì Android treo tiến trình vài giây sau khi màn hình tắt, và lượt làm việc dài của agent đứng im giữa đường.",
    "cap.wake_lock.fix": "Chạy: pkg install termux-api",

    "cap.privilege.title": "Quyền nâng cao (chống Android giết tiến trình)",
    "cap.privilege.why":
      "Android 12 trở lên giới hạn mỗi app khoảng 32 tiến trình con rồi giết phần dư. Agent tạo một shell cho mỗi lệnh, nên task dài bị ngắt ngẫu nhiên.",
    "cap.privilege.fix": "Mở phần Quyền nâng cao bên dưới và chọn một cách cấp quyền.",

    "cap.service.title": "Tự chạy lại khi bị tắt",
    "cap.service.why": "Có termux-services thì daemon sống lại khi Android kill Termux.",
    "cap.service.fix": "Chạy: pkg install termux-services",

    "cap.python.title": "Chạy được code Python",
    "cap.python.why": "Không có Python thì agent viết được file .py nhưng không chạy thử được.",
    "cap.python.fix": "Chạy: pkg install python",

    "cap.build_tools.title": "Biên dịch được C/C++",
    "cap.build_tools.why": "clang và make để agent build thật, không chỉ viết ra rồi đoán.",
    "cap.build_tools.fix": "Chạy: pkg install clang make binutils",

    "cap.ssh.title": "Code từ máy tính vào điện thoại",
    "cap.ssh.why": "Bật sshd để bạn ssh từ laptop vào đúng thư mục làm việc này.",
    "cap.ssh.fix": "Chạy: pkg install openssh",

    "cap.jq.title": "Xử lý JSON trong shell",
    "cap.jq.why": "Nhiều lệnh agent hay dùng cần jq để đọc JSON.",
    "cap.jq.fix": "Chạy: pkg install jq",

    "cap.proot.title": "Linux đầy đủ trong Termux",
    "cap.proot.why":
      "proot-distro cho agent một bản Debian thật: có apt, gcc, và mọi gói Termux không có. Đây là bước nhảy lớn nhất về năng lực, nhưng tải khá nặng.",
    "cap.proot.fix": "Chạy: pkg install proot-distro",

    // --------------------------------------------------- quyền nâng cao
    "priv.none.label": "Chưa có quyền nâng cao",
    "priv.root.label": "Đang dùng root",
    "priv.rish.label": "Đang dùng Shizuku",
    "priv.adb.label": "Đang dùng ADB",
    "priv.root.detail": "Tốt nhất — quyền giữ vĩnh viễn, không cần ghép nối lại.",
    "priv.rish.detail": "Ổn định — chỉ cần mở lại app Shizuku sau khi khởi động máy.",
    "priv.adb.detail": "Hoạt động — nhưng mất sau khi khởi động lại máy, phải ghép nối lại.",
    "priv.none.detail": "Android đang giới hạn agent. Chọn một cách bên dưới để mở khoá.",

    "priv.method.recheck.title": "Kiểm tra lại",
    "priv.method.recheck.desc": "Nếu bạn đã cấp ADB rồi, hoặc vừa mở lại Shizuku.",
    "priv.method.pair.title": "Ghép mã không dây",
    "priv.method.pair.desc": "Không cần máy tính. Cần Android 11+. Mất sau khi khởi động lại.",
    "priv.method.shizuku.title": "Dùng Shizuku",
    "priv.method.shizuku.desc": "Ổn định hơn, chỉ ghép nối một lần.",
    "priv.method.root.title": "Máy đã root",
    "priv.method.root.desc": "Tốt nhất — quyền giữ vĩnh viễn.",

    "priv.unlock.phantom": "Bỏ giới hạn tiến trình con",
    "priv.unlock.doze": "Miễn trừ tiết kiệm pin (Doze)",
    "priv.unlock.background": "Cho phép chạy nền",
    "priv.unlock.wakelock": "Cho phép giữ wake lock",
    "priv.unlock.foreground": "Cho phép foreground service",

    "priv.err.no_backend": "Không tìm thấy cách nào để chạy lệnh có quyền. Hãy thiết lập ADB, Shizuku, hoặc root.",
    "priv.err.bad_address": "Địa chỉ phải có dạng IP:PORT, ví dụ 192.168.1.5:38721",
    "priv.err.bad_code": "Mã ghép nối phải là 6 chữ số.",
    "priv.err.no_adb": "Chưa có adb. Bấm cài android-tools trước.",
    "priv.err.pair_failed": "Ghép nối thất bại. Kiểm tra lại IP:PORT và mã — mã đổi mỗi lần mở lại màn hình ghép nối.",
    "priv.err.connect_failed": "Kết nối thất bại. Nhớ dùng cổng ở màn hình chính, khác cổng ghép nối.",
    "priv.err.rish_missing": "Chưa thấy rish trong thư mục nhà. Làm theo hướng dẫn Shizuku ở trên.",
    "priv.err.rish_dead": "Có file rish nhưng chạy không được — thường là app Shizuku chưa được Start.",
    "priv.err.no_root": "Không dùng được su. Máy này có thể chưa root.",

    // -------------------------------------------------------- trạng thái
    "status.phantom.value": "Giới hạn tiến trình con: {n}",
    "status.phantom.unknown": "Giới hạn tiến trình con: chưa đọc được (cần quyền nâng cao)",
    "status.env_keys": "API key trong môi trường: {list}",
    "status.env_keys.none": "Không có API key nào trong môi trường",
    "status.providers": "{n} provider đã cấu hình",
    "status.score": "Sức mạnh agent",
  },

  en: {
    // ---------------------------------------------------------------- tiers
    "tier.required": "Required",
    "tier.recommended": "Recommended",
    "tier.advanced": "Advanced",
    "tier.required.hint": "Without these the agent cannot run at all.",
    "tier.recommended.hint": "Small downloads, large difference.",
    "tier.advanced.hint": "Heavier. Install only if you need them.",

    // ----------------------------------------------------------- common
    "common.installed": "Installed",
    "common.missing": "Missing",
    "common.unknown": "Unknown",
    "common.install": "Install",
    "common.installing": "Installing\u2026",
    "common.recheck": "Recheck",
    "common.size": "{n} MB",
    "common.package": "package {name}",

    // ----------------------------------------------------- capabilities
    "cap.node.title": "Node.js",
    "cap.node.why": "The whole agent runs on Node. Version 20 or newer.",
    "cap.node.fix": "Run: pkg install nodejs",

    "cap.provider.title": "A model is connected",
    "cap.provider.why": "Without a model the agent cannot think at all.",
    "cap.provider.fix": "Open the Settings tab and add a provider and API key.",

    "cap.workspace.title": "Workspace directory",
    "cap.workspace.why": "The agent may only read and write inside this directory.",
    "cap.workspace.fix": "Create it: mkdir -p {path}",

    "cap.shell.title": "Shell",
    "cap.shell.why": "Without a shell the agent cannot run any command.",
    "cap.shell.fix": "Run: pkg install bash",

    "cap.git.title": "Git",
    "cap.git.why": "So the agent can see changes and commit, and you can undo a bad edit.",
    "cap.git.fix": "Run: pkg install git",

    "cap.fast_search.title": "Much faster code search",
    "cap.fast_search.why":
      "Without ripgrep the grep tool walks every file in JavaScript. On a few thousand files that is seconds per search on a phone.",
    "cap.fast_search.fix": "Run: pkg install ripgrep",

    "cap.fast_glob.title": "Faster file listing",
    "cap.fast_glob.why": "fd makes the glob tool faster and honours .gitignore properly.",
    "cap.fast_glob.fix": "Run: pkg install fd",

    "cap.notifications.title": "Notify me when the agent is done",
    "cap.notifications.why":
      "On a phone you switch apps constantly. Without this you cannot tell whether the agent finished or is waiting for you to approve a command.",
    "cap.notifications.fix": "Run: pkg install termux-api \u2014 and install the Termux:API app from F-Droid.",

    "cap.storage.title": "Storage permission",
    "cap.storage.why": "So config.json can be edited with any text app, and files in Download are reachable.",
    "cap.storage.fix": "Run: termux-setup-storage and tap Allow.",

    "cap.wake_lock.title": "Keep running when the screen is off",
    "cap.wake_lock.why":
      "Without a wake lock Android suspends the process seconds after the screen goes off, and a long agent turn silently stalls.",
    "cap.wake_lock.fix": "Run: pkg install termux-api",

    "cap.privilege.title": "Elevated privileges (stop Android killing processes)",
    "cap.privilege.why":
      "Android 12+ caps an app at about 32 child processes and kills the rest. The agent spawns a shell per command, so long tasks break at random.",
    "cap.privilege.fix": "Open Elevated privileges below and pick a method.",

    "cap.service.title": "Restart automatically when killed",
    "cap.service.why": "With termux-services the daemon comes back when Android kills Termux.",
    "cap.service.fix": "Run: pkg install termux-services",

    "cap.python.title": "Run Python code",
    "cap.python.why": "Without Python the agent can write .py files but never test them.",
    "cap.python.fix": "Run: pkg install python",

    "cap.build_tools.title": "Compile C/C++",
    "cap.build_tools.why": "clang and make let the agent actually build, instead of writing and guessing.",
    "cap.build_tools.fix": "Run: pkg install clang make binutils",

    "cap.ssh.title": "Code from a computer into the phone",
    "cap.ssh.why": "Run sshd so you can ssh from a laptop into this same workspace.",
    "cap.ssh.fix": "Run: pkg install openssh",

    "cap.jq.title": "Handle JSON in the shell",
    "cap.jq.why": "Many commands the agent reaches for need jq to read JSON.",
    "cap.jq.fix": "Run: pkg install jq",

    "cap.proot.title": "A full Linux inside Termux",
    "cap.proot.why":
      "proot-distro gives the agent a real Debian: apt, gcc, and every package Termux lacks. The biggest capability jump available, but a large download.",
    "cap.proot.fix": "Run: pkg install proot-distro",

    // ------------------------------------------------------- privileges
    "priv.none.label": "No elevated privileges",
    "priv.root.label": "Using root",
    "priv.rish.label": "Using Shizuku",
    "priv.adb.label": "Using ADB",
    "priv.root.detail": "Best \u2014 survives reboot, no pairing needed.",
    "priv.rish.detail": "Stable \u2014 you only reopen the Shizuku app after a reboot.",
    "priv.adb.detail": "Working \u2014 but lost on reboot, you must pair again.",
    "priv.none.detail": "Android is limiting the agent. Pick a method below to unlock it.",

    "priv.method.recheck.title": "Recheck",
    "priv.method.recheck.desc": "If you already granted ADB, or just reopened Shizuku.",
    "priv.method.pair.title": "Wireless pairing code",
    "priv.method.pair.desc": "No computer needed. Android 11+. Lost on reboot.",
    "priv.method.shizuku.title": "Use Shizuku",
    "priv.method.shizuku.desc": "More stable, pair only once.",
    "priv.method.root.title": "This device is rooted",
    "priv.method.root.desc": "Best \u2014 survives reboot.",

    "priv.unlock.phantom": "Remove the child process cap",
    "priv.unlock.doze": "Exempt from battery saver (Doze)",
    "priv.unlock.background": "Allow running in the background",
    "priv.unlock.wakelock": "Allow holding a wake lock",
    "priv.unlock.foreground": "Allow foreground services",

    "priv.err.no_backend": "No way to run a privileged command was found. Set up ADB, Shizuku, or root.",
    "priv.err.bad_address": "The address must look like IP:PORT, for example 192.168.1.5:38721",
    "priv.err.bad_code": "The pairing code must be 6 digits.",
    "priv.err.no_adb": "adb is not installed. Install android-tools first.",
    "priv.err.pair_failed":
      "Pairing failed. Check the address and code \u2014 the code changes every time you reopen the pairing screen.",
    "priv.err.connect_failed": "Connection failed. Use the port from the main screen, not the pairing port.",
    "priv.err.rish_missing": "rish was not found in your home directory. Follow the Shizuku steps above.",
    "priv.err.rish_dead": "rish is present but does not work \u2014 usually the Shizuku app has not been started.",
    "priv.err.no_root": "su did not work. This device is probably not rooted.",

    // ----------------------------------------------------------- status
    "status.phantom.value": "Child process limit: {n}",
    "status.phantom.unknown": "Child process limit: unreadable (needs elevated privileges)",
    "status.env_keys": "API keys in the environment: {list}",
    "status.env_keys.none": "No API keys in the environment",
    "status.providers": "{n} provider(s) configured",
    "status.score": "Agent power",
  },
};

/**
 * Look up a key. Falls back to English, then to the key itself, so a missing
 * translation degrades to something readable instead of blank UI.
 * @param {string} lang
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 */
export function t(lang, key, params) {
  const table = DICT[/** @type {Lang} */ (lang)] || DICT.en;
  let s = table[key] ?? DICT.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}

/** Normalise anything into a supported language code. */
export function pickLang(value) {
  const s = String(value || "").toLowerCase();
  for (const l of LANGS) if (s.startsWith(l)) return l;
  return DEFAULT_LANG;
}
