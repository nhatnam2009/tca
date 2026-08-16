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
    "tier.core": "Nền tảng",
    "tier.device": "Cần bạn làm",
    "tier.optional": "Thêm nếu cần",
    "tier.core.hint": "Lệnh cài đặt đã lo hết. Nếu thiếu là lần cài bị lỗi.",
    "tier.device.hint": "Chỉ bạn làm được: hộp thoại Android, app từ F-Droid, hoặc ghép nối ADB.",
    "tier.optional.hint": "Nặng, và thật sự là tuỳ chọn. Hỏi trước khi tải.",

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

    "cap.boot.title": "Tự chạy sau khi khởi động máy",
    "cap.boot.why":
      "Android không cho app thường có service lúc boot, nên sau khi khởi động lại bạn phải mở Termux mới có agent. App Termux:Boot giải quyết việc đó.",
    "cap.boot.fix": "Cài app Termux:Boot từ F-Droid, rồi bấm nút bên dưới để tạo script khởi động.",

    "boot.install": "Tạo script khởi động",
    "boot.installed": "Đã tạo. Cài app Termux:Boot từ F-Droid là xong.",
    "boot.remove": "Bỏ tự chạy khi khởi động",
    "boot.removed": "Đã bỏ script khởi động.",
    "boot.appNote": "Script đã có. Nó chỉ chạy nếu app Termux:Boot được cài — Termux không kiểm tra được điều đó từ bên trong.",

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
    "status.phantom.value": "Giới hạn tiến trình con: {n}",
    "status.phantom.unknown": "Giới hạn tiến trình con: chưa đọc được (cần quyền nâng cao)",
    "status.env_keys": "API key trong môi trường: {list}",
    "status.env_keys.none": "Không có API key nào trong môi trường",
    "status.providers": "{n} provider đã cấu hình",
    "status.score": "Sức mạnh agent",

    // ----------------------------------------------------------- token gate
    "gate.title": "Cần mã truy cập",
    "gate.help":
      "Khi khởi động, agent in ra một đường link dạng http://127.0.0.1:8787/?token=… Mở link đó, hoặc dán riêng phần mã vào đây.",
    "gate.label": "Mã truy cập",
    "gate.save": "Lưu mã",
    "gate.rejected": "Mã đó bị từ chối. Dán lại mã hiện tại.",

    // ------------------------------------------------------------- khung app
    "app.name": "TCA Agent",
    "app.skipToComposer": "Bỏ qua, tới ô nhập tin",
    "app.sections": "Các phần",
    "tab.chat": "Chat",
    "tab.power": "Sức mạnh",
    "tab.settings": "Cài đặt",

    // ---------------------------------------------------------------- wizard
    "wizard.title": "Thiết lập model",
    "wizard.step.model": "Model",
    "wizard.step.key": "API key",
    "wizard.step.modelId": "Mã model",
    "wizard.step.test": "Kiểm tra",
    "wizard.s1.title": "Chọn một model",
    "wizard.s1.hint": "Bấm vào một cái. Chưa lưu gì cho tới bước cuối.",
    "wizard.s1.showAll": "Xem tất cả provider",
    "wizard.s2.title": "Dán API key của bạn",
    "wizard.s2.nameLabel": "Tên cho provider này",
    "wizard.s2.nameHint": "Dùng làm khoá trong file config.",
    "wizard.s2.baseUrlLabel": "Base URL",
    "wizard.s2.kindLabel": "Loại API",
    "wizard.s2.keyLabel": "API key",
    "wizard.s2.keyHint":
      "Lưu vào file config. Bạn cũng có thể nhập ${TÊN_BIẾN} để đọc từ biến môi trường thay vì lưu thẳng.",
    "wizard.s3.title": "Chọn model",
    "wizard.s3.serverUrlLabel": "Địa chỉ server",
    "wizard.s3.serverUrlHint": "Dùng địa chỉ LAN của máy tính để điều khiển GPU máy tính từ điện thoại.",
    "wizard.s3.askModels": "Hỏi server xem có model nào",
    "wizard.s3.modelsLabel": "Danh sách model",
    "wizard.s3.modelIdLabel": "Mã model",
    "wizard.s4.title": "Kiểm tra rồi hoàn tất",
    "wizard.s4.hint": "Gửi một request 1 token, để key sai lộ ra ngay bây giờ chứ không phải giữa lúc làm việc.",
    "wizard.back": "Quay lại",
    "wizard.next": "Tiếp",
    "wizard.skip": "Bỏ qua, tôi tự cấu hình",

    // ------------------------------------------------------------------ chat
    "chat.session": "Phiên",
    "chat.new": "Mới",
    "chat.delete": "Xoá",
    "chat.conversation": "Cuộc hội thoại",
    "chat.jumpLatest": "Xuống tin mới nhất",
    "chat.stop": "Dừng",
    "chat.send": "Gửi",
    "chat.messageLabel": "Nội dung",
    "chat.placeholder": "Nói cho agent biết bạn muốn sửa gì…",
    "chat.composerHint": "Enter để xuống dòng. Bấm nút Gửi, hoặc Ctrl kèm Enter, để gửi.",
    "chat.working": "Đang làm…",
    "chat.reconnecting": "Mất kết nối – đang kết nối lại…",
    "chat.disconnected": "Đã ngắt kết nối – tải lại trang để kết nối lại.",
    "chat.empty": "Chưa có tin nhắn nào. Hãy nói bạn muốn thay đổi gì.",
    "chat.you": "Bạn",
    "chat.assistant": "Agent",
    "chat.tokens": "{in} vào · {out} ra token",
    "chat.stopped": "đã dừng: {reason}",
    "chat.deleteConfirm": "Xoá \"{name}\"? Không thể hoàn tác.",
    "chat.deleted": "Đã xoá phiên",
    "chat.sessionFallback": "Phiên {id}",

    // -------------------------------------------------------------- approval
    "approval.command.title": "Chạy lệnh này?",
    "approval.edit.title": "Cho phép sửa file này?",
    "approval.command.aria": "Yêu cầu duyệt lệnh",
    "approval.edit.aria": "Yêu cầu duyệt thay đổi file",
    "approval.allow": "Cho phép",
    "approval.deny": "Từ chối",
    "approval.allowed": "Đã cho phép",
    "approval.denied": "Đã từ chối",
    "approval.timedOut": "Hết thời gian – không chạy",
    "approval.cancelled": "Đã huỷ",
    "approval.toast.command": "Cần bạn duyệt một lệnh",
    "approval.toast.edit": "Cần bạn duyệt một thay đổi file",
    "approval.cwd": "thư mục: {path}",
    "approval.workspace": "thư mục làm việc: {path}",

    // ------------------------------------------------------------ tool rows
    "tool.input": "đầu vào",
    "tool.output": "kết quả",
    "tool.ok": "xong",
    "tool.error": "lỗi",
    "code.copy": "Chép",
    "code.copied": "Đã chép",
    "code.copyFailed": "Không chép được",
    "code.copyAria": "Chép khối mã",

    // ---------------------------------------------------------------- settings
    "settings.title": "Cài đặt",
    "settings.configFile": "File config:",
    "settings.handEdit":
      "File này là JSON thuần — bạn có thể sửa tay bằng bất kỳ app soạn thảo rồi bấm “Tải lại từ đĩa”.",
    "settings.save": "Lưu cài đặt",
    "settings.reload": "Tải lại từ đĩa",
    "settings.langLabel": "Ngôn ngữ",
    "settings.langHint": "Áp dụng cho cả web UI và lệnh tca doctor trong terminal.",

    "provider.legend": "Provider",
    "provider.active": "Provider đang dùng",
    "provider.add": "Thêm provider",
    "provider.remove": "Xoá",
    "provider.kind": "Loại API",
    "provider.baseUrl": "Base URL",
    "provider.apiKey": "API key",
    "provider.show": "Hiện",
    "provider.hide": "Ẩn",
    "provider.apiKeyHint":
      "Để nguyên nếu muốn giữ key đã lưu trên server. Bạn cũng có thể nhập ${TÊN_BIẾN} để đọc từ biến môi trường thay vì lưu thẳng.",
    "provider.model": "Model",
    "provider.modelId": "Mã model (đang dùng)",
    "provider.saveId": "+ Lưu",
    "provider.modelIdHint":
      "Catalog có thể cũ, nên mã model bạn tự gõ vào đây được giữ nguyên. Bấm “+ Lưu” để thêm vào danh sách bên dưới cho lần sau, không mất các mã cũ.",
    "provider.test": "Kiểm tra kết nối",
    "provider.refreshLive": "Lấy lại từ provider",
    "provider.testHint": "Kiểm tra dùng provider đã lưu trên server — hãy lưu trước nếu bạn vừa đổi key.",
    "provider.maxTokens": "Token đầu ra tối đa",
    "provider.testOk": "Kết nối OK — {model} đã trả lời.",
    "provider.testOkPlain": "Kết nối OK.",
    "provider.testFailed": "Kiểm tra thất bại.",
    "provider.testing": "Đang kiểm tra…",

    "catalog.legend": "Danh mục model",
    "catalog.search": "Tìm trong mọi provider",
    "catalog.searchHint": "Dùng khi bạn biết tên model nhưng không biết của hãng nào.",
    "catalog.searchPlaceholder": "kimi, sonnet, qwen…",
    "catalog.download": "Tải danh mục đầy đủ (3.8 MB)",
    "catalog.redownload": "Tải lại danh mục đầy đủ (3.8 MB)",
    "catalog.downloadHint":
      "Danh sách đi kèm đã có sẵn các model phổ biến, dùng offline được. Tải danh mục đầy đủ từ models.dev tốn khoảng 3.8 MB dữ liệu.",
    "catalog.downloadConfirm":
      "Tải danh mục model đầy đủ từ models.dev?\n\nKhoảng 3.8 MB — sẽ dùng dữ liệu di động nếu bạn không ở Wi-Fi.",
    "catalog.downloading": "Đang tải…",
    "catalog.updated": "Đã cập nhật danh mục: {models} model từ {providers} provider",
    "catalog.source.full": "danh mục đầy đủ từ models.dev",
    "catalog.source.seed": "danh sách offline đi kèm",
    "catalog.info": "Danh mục: {source} · {models} model gọi được tool · {providers} provider · tạo ngày {generated}",

    "agent.legend": "Agent",
    "agent.workspace": "Thư mục làm việc",
    "agent.workspaceHint": "Agent chỉ được đọc và ghi bên trong thư mục này.",
    "agent.autoApprove": "Tự động cho phép lệnh shell",
    "agent.autoApproveHint":
      "Tắt (khuyên dùng): agent hỏi bạn trước khi chạy bất kỳ lệnh nào. Bật: chạy ngay, không hỏi.",
    "agent.autoApproveEdits": "Tự động cho phép sửa file",
    "agent.autoApproveEditsHint":
      "Bật (mặc định): agent ghi, sửa, di chuyển và xoá file trong thư mục làm việc mà không hỏi. Tắt để duyệt từng thay đổi — an toàn hơn nhưng phải bấm nhiều.",
    "agent.maxSteps": "Số bước tối đa mỗi lượt",
    "agent.instructions": "Chỉ dẫn thêm",
    "agent.instructionsHint": "Được thêm vào system prompt của mọi phiên.",
    "agent.deny": "Lệnh bị chặn",
    "agent.denyHint": "Mỗi dòng một biểu thức chính quy. Lệnh khớp luôn bị chặn, kể cả khi đã bật tự động cho phép.",

    // ------------------------------------------------------- thông báo ngắn
    "ui.stopping": "Đang dừng…",
    "ui.checking": "Đang kiểm tra…",
    "ui.searching": "Đang tìm…",
    "ui.configReloaded": "Đã tải lại config từ đĩa",
    "ui.savedTo": "Đã lưu vào {path}",
    "ui.removedSaveToPersist": "Đã xoá — bấm “Lưu cài đặt” để lưu hẳn",
    "ui.removedRememberSave": "Đã xoá — nhớ bấm lưu",
    "ui.savedRememberSave": "Đã chọn — nhớ bấm “Lưu cài đặt”",
    "ui.pickModelFirst": "Hãy nhập hoặc chọn mã model trước",
    "ui.alreadySaved": "“{id}” đã có trong danh sách",
    "ui.pickedRememberSave": "{provider}: {model} — nhớ bấm lưu",
    "ui.finishingSetup": "{provider} chưa được thiết lập — đang hoàn tất cho nó",
    "ui.providerReady": "Provider “{id}” đã sẵn sàng",
    "ui.noMatch": "Không tìm thấy gì. Thử từ ngắn hơn.",
    "ui.noRecommendations": "Server không trả về gợi ý nào.",
    "ui.noSavedIds": "Provider này chưa có mã model nào được lưu.",
    "ui.notTermux": "Không chạy trên Termux — bỏ qua các mục chỉ dành cho Android.",
    "ui.getApiKey": "Lấy API key",
    "ui.manualBaseUrl": "cần nhập base URL thủ công",

    // ---------------------------------------------------------- k\u1ebf ho\u1ea1ch
    "todo.title": "Kế hoạch",
    "todo.progress": "{done}/{total} xong",
    "todo.status.pending": "chưa làm",
    "todo.status.in_progress": "đang làm",
    "todo.status.done": "đã xong",

    // ------------------------------------------------------------ tab Power
    "power.allGood": "Mọi thứ ở tầng này đã sẵn sàng.",
    "power.installed": "Đã cài xong: {title}",
    "power.installFailed": "Cài thất bại. Xem chi tiết bên dưới.",
    "power.installLog": "Chi tiết",
    "power.privSection": "Quyền nâng cao",
    "power.chooseMethod": "Chọn cách cấp quyền:",
    "power.step": "Bước {n}/{total}",
    "power.applied": "Đã áp dụng {ok}/{total} mở khoá",
    "power.appliedAll": "Đã mở khoá xong. Agent tạo bao nhiêu tiến trình cũng được.",
    "power.appliedSome": "Một số mở khoá bị từ chối. Vài hãng chặn appops kể cả qua ADB; mục quan trọng nhất là mục đầu.",
    "power.rebootWarn": "Ghép nối ADB không dây mất sau khi khởi động lại máy. Lúc đó chạy lại phần này.",

    "power.coreOk": "Nền tảng đầy đủ",
    "power.coreOkNote": "{n} thứ đã sẵn sàng — lệnh cài đặt đã lo hết.",
    "power.repair": "Sửa lần cài ({n})",
    "power.repairNote":
      "{n} thứ đáng lẽ đã được cài bởi lệnh cài đặt nhưng không có. Thường là do lần cài bị ngắt giữa đường.",
    "power.installAll": "Cài tất cả ({n} · {mb} MB)",
    "power.confirmSize": "Tải khoảng {mb} MB?\n\nSẽ dùng dữ liệu di động nếu bạn không ở Wi-Fi.",
    "power.progressTitle": "Đang cài",
    "power.progressItem": "{n}/{total} · {title}",
    "power.phase.download": "đang tải…",
    "power.phase.unpack": "đang giải nén…",
    "power.phase.configure": "đang cấu hình…",
    "power.phase.start": "đang bắt đầu…",
    "power.installedN": "Đã cài xong {n} thứ.",
    "power.failedAt": "Thất bại ở: {title}",
    "power.busy": "Đang có lượt cài khác chạy — chờ nó xong.",

    "priv.pair.installAdb": "Cài android-tools",
    "priv.pair.s1.title": "Bật Gỡ lỗi không dây",
    "priv.pair.s1.body":
      "Cài đặt → Tùy chọn nhà phát triển → Gỡ lỗi không dây → Bật. Chưa thấy Tùy chọn nhà phát triển? Vào Cài đặt → Giới thiệu điện thoại → bấm “Số bản dựng” 7 lần.",
    "priv.pair.s1.done": "Đã bật, tiếp →",
    "priv.pair.s2.title": "Nhập mã ghép nối",
    "priv.pair.s2.body":
      "Bấm “Ghép nối thiết bị bằng mã ghép nối”. Nó hiện một địa chỉ IP:PORT và một mã 6 số. Cổng này KHÁC cổng ở màn hình chính.",
    "priv.pair.addrLabel": "IP:PORT ghép nối",
    "priv.pair.codeLabel": "Mã 6 số",
    "priv.pair.paired": "Ghép nối thành công.",
    "priv.pair.s3.title": "Kết nối",
    "priv.pair.s3.body": "Quay lại màn hình Gỡ lỗi không dây chính và đọc IP:PORT ở đó — cổng khác với cổng ghép nối.",
    "priv.pair.connectLabel": "IP:PORT kết nối",
    "priv.pair.doConnect": "Kết nối và mở khoá",

    "priv.shizuku.s1": "Cài app Shizuku từ F-Droid hoặc Google Play.",
    "priv.shizuku.s2": "Mở Shizuku → bấm Start. Shizuku tự lo phần ghép nối, chỉ một lần.",
    "priv.shizuku.s3": "Trong Shizuku chọn “Use Shizuku in terminal apps” → export file ra thư mục Download.",
    "priv.shizuku.s4": "Copy 2 file đó vào Termux, rồi bấm kiểm tra.",
    "priv.shizuku.copy": "Copy file rish từ Download",
    "priv.shizuku.copied": "Đã copy. Bấm kiểm tra.",
    "priv.shizuku.check": "Kiểm tra rish",
    "priv.shizuku.storageFirst": "Cần quyền bộ nhớ trước. Chạy termux-setup-storage trong Termux.",

    "priv.root.check": "Thử bằng su",
    "priv.handledByCli":
      "Mỗi lần gõ nhatnam, agent tự tìm quyền và áp dụng luôn. Nếu bạn cấp ADB ở một cửa sổ Termux khác, nó sẽ tự nhận trong vòng 20 giây — không cần khởi động lại.",
  },

  en: {
    // ---------------------------------------------------------------- tiers
    "tier.core": "Foundation",
    "tier.device": "Needs you",
    "tier.optional": "Add if you need it",
    "tier.core.hint": "The install command handled all of this. A gap here means it failed.",
    "tier.device.hint": "Only you can do these: an Android dialog, an app from F-Droid, or ADB pairing.",
    "tier.optional.hint": "Heavy, and genuinely a choice. It asks before downloading.",

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

    "cap.boot.title": "Start when the phone starts",
    "cap.boot.why":
      "Android gives an ordinary app no boot service, so after a restart you have to open Termux before the agent exists. The Termux:Boot app fixes that.",
    "cap.boot.fix": "Install Termux:Boot from F-Droid, then press the button below to write the startup script.",

    "boot.install": "Write the startup script",
    "boot.installed": "Written. Install the Termux:Boot app from F-Droid and it is done.",
    "boot.remove": "Stop starting on boot",
    "boot.removed": "Startup script removed.",
    "boot.appNote": "The script is in place. It only runs if the Termux:Boot app is installed, which Termux cannot check from the inside.",

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

    // ----------------------------------------------------------- token gate
    "gate.title": "Access token needed",
    "gate.help":
      "The daemon prints a URL like http://127.0.0.1:8787/?token=… when it starts. Open that URL, or paste just the token here.",
    "gate.label": "Access token",
    "gate.save": "Save token",
    "gate.rejected": "That token was rejected. Paste the current one.",

    // --------------------------------------------------------------- shell
    "app.name": "TCA Agent",
    "app.skipToComposer": "Skip to message composer",
    "app.sections": "Sections",
    "tab.chat": "Chat",
    "tab.power": "Power",
    "tab.settings": "Settings",

    // ---------------------------------------------------------------- wizard
    "wizard.title": "Set up a model",
    "wizard.step.model": "Model",
    "wizard.step.key": "Key",
    "wizard.step.modelId": "Model id",
    "wizard.step.test": "Test",
    "wizard.s1.title": "Choose a model",
    "wizard.s1.hint": "Tap one. Nothing is saved until the last step.",
    "wizard.s1.showAll": "Show all providers",
    "wizard.s2.title": "Paste your API key",
    "wizard.s2.nameLabel": "Name for this provider",
    "wizard.s2.nameHint": "Used as the key in the config file.",
    "wizard.s2.baseUrlLabel": "Base URL",
    "wizard.s2.kindLabel": "API kind",
    "wizard.s2.keyLabel": "API key",
    "wizard.s2.keyHint":
      "Stored in the config file. You can also enter ${ENV_NAME} to read it from an environment variable instead.",
    "wizard.s3.title": "Pick a model",
    "wizard.s3.serverUrlLabel": "Server URL",
    "wizard.s3.serverUrlHint": "Use your computer's LAN address to drive a desktop GPU from the phone.",
    "wizard.s3.askModels": "Ask the server which models it has",
    "wizard.s3.modelsLabel": "Models",
    "wizard.s3.modelIdLabel": "Model id",
    "wizard.s4.title": "Test and finish",
    "wizard.s4.hint": "Sends one 1-token request so a wrong key shows up now, not mid-task.",
    "wizard.back": "Back",
    "wizard.next": "Next",
    "wizard.skip": "Skip, I'll configure it myself",

    // ------------------------------------------------------------------ chat
    "chat.session": "Session",
    "chat.new": "New",
    "chat.delete": "Delete",
    "chat.conversation": "Conversation",
    "chat.jumpLatest": "Jump to latest",
    "chat.stop": "Stop",
    "chat.send": "Send",
    "chat.messageLabel": "Message",
    "chat.placeholder": "Ask the agent to change something…",
    "chat.composerHint": "Enter inserts a new line. Press the Send button, or Control plus Enter, to send.",
    "chat.working": "Working…",
    "chat.reconnecting": "Connection lost – reconnecting…",
    "chat.disconnected": "Disconnected – reload to reconnect.",
    "chat.empty": "No messages yet. Describe what you want changed.",
    "chat.you": "You",
    "chat.assistant": "Assistant",
    "chat.tokens": "{in} in · {out} out tokens",
    "chat.stopped": "stopped: {reason}",
    "chat.deleteConfirm": "Delete \"{name}\"? This cannot be undone.",
    "chat.deleted": "Session deleted",
    "chat.sessionFallback": "Session {id}",

    // -------------------------------------------------------------- approval
    "approval.command.title": "Run this command?",
    "approval.edit.title": "Allow this file change?",
    "approval.command.aria": "Command approval request",
    "approval.edit.aria": "File change approval request",
    "approval.allow": "Allow",
    "approval.deny": "Deny",
    "approval.allowed": "Allowed",
    "approval.denied": "Denied",
    "approval.timedOut": "Timed out – not run",
    "approval.cancelled": "Cancelled",
    "approval.toast.command": "Approval required to run a command",
    "approval.toast.edit": "Approval required to change a file",
    "approval.cwd": "cwd: {path}",
    "approval.workspace": "workspace: {path}",

    // ------------------------------------------------------------ tool rows
    "tool.input": "input",
    "tool.output": "output",
    "tool.ok": "ok",
    "tool.error": "error",
    "code.copy": "Copy",
    "code.copied": "Copied",
    "code.copyFailed": "Failed",
    "code.copyAria": "Copy code block",

    // ---------------------------------------------------------------- settings
    "settings.title": "Settings",
    "settings.configFile": "Config file:",
    "settings.handEdit":
      "This file is plain JSON — you can also edit it by hand with any text editor and press “Reload from disk”.",
    "settings.save": "Save settings",
    "settings.reload": "Reload from disk",
    "settings.langLabel": "Language",
    "settings.langHint": "Applies to the web UI and to tca doctor in the terminal.",

    "provider.legend": "Provider",
    "provider.active": "Active provider",
    "provider.add": "Add provider",
    "provider.remove": "Remove",
    "provider.kind": "API kind",
    "provider.baseUrl": "Base URL",
    "provider.apiKey": "API key",
    "provider.show": "Show",
    "provider.hide": "Hide",
    "provider.apiKeyHint":
      "Leave untouched to keep the key already stored on the server. You can also enter ${ENV_NAME} to read it from an environment variable instead of storing it.",
    "provider.model": "Model",
    "provider.modelId": "Model id (active)",
    "provider.saveId": "+ Save",
    "provider.modelIdHint":
      "Catalogs go stale, so any model id you type here is kept as-is. Tap “+ Save” to keep it in the list below for quick switching, without losing the others.",
    "provider.test": "Test connection",
    "provider.refreshLive": "Refresh from provider",
    "provider.testHint": "Test uses the provider as already saved on the server — save first if you just changed the key.",
    "provider.maxTokens": "Max output tokens",
    "provider.testOk": "Connection OK — {model} answered.",
    "provider.testOkPlain": "Connection OK.",
    "provider.testFailed": "Test failed.",
    "provider.testing": "Testing…",

    "catalog.legend": "Model catalog",
    "catalog.search": "Search every provider",
    "catalog.searchHint": "Finds a model when you know its name but not the vendor.",
    "catalog.searchPlaceholder": "kimi, sonnet, qwen…",
    "catalog.download": "Download full catalog (3.8 MB)",
    "catalog.redownload": "Re-download full catalog (3.8 MB)",
    "catalog.downloadHint":
      "The bundled list covers the popular models offline. Downloading the full models.dev catalog uses about 3.8 MB of data.",
    "catalog.downloadConfirm":
      "Download the full model catalog from models.dev?\n\nThat is about 3.8 MB — it will use mobile data if you are not on Wi-Fi.",
    "catalog.downloading": "Downloading…",
    "catalog.updated": "Catalog updated: {models} models from {providers} providers",
    "catalog.source.full": "full catalog from models.dev",
    "catalog.source.seed": "bundled offline list",
    "catalog.info": "Catalog: {source} · {models} tool-capable models · {providers} providers · generated {generated}",

    "agent.legend": "Agent",
    "agent.workspace": "Workspace directory",
    "agent.workspaceHint": "The agent may only read and write inside this directory.",
    "agent.autoApprove": "Auto-approve shell commands",
    "agent.autoApproveHint":
      "Off (recommended): the agent asks you before running any shell command. On: it runs commands immediately, without asking.",
    "agent.autoApproveEdits": "Auto-approve file changes",
    "agent.autoApproveEditsHint":
      "On (default): the agent writes, edits, moves and deletes files in the workspace without asking. Turn it off to confirm each change — safer, but a lot of tapping.",
    "agent.maxSteps": "Max steps per turn",
    "agent.instructions": "Extra instructions",
    "agent.instructionsHint": "Appended to the system prompt for every session.",
    "agent.deny": "Denied commands",
    "agent.denyHint": "One regular expression per line. Matching commands are always blocked, even with auto-approve on.",

    // ----------------------------------------------------- short UI notices
    "ui.stopping": "Stopping…",
    "ui.checking": "Checking…",
    "ui.searching": "Searching…",
    "ui.configReloaded": "Config reloaded from disk",
    "ui.savedTo": "Saved to {path}",
    "ui.removedSaveToPersist": "Removed — press “Save settings” to make it permanent",
    "ui.removedRememberSave": "Removed — remember to save",
    "ui.savedRememberSave": "Saved — remember to press “Save settings”",
    "ui.pickModelFirst": "Type or pick a model id first",
    "ui.alreadySaved": "“{id}” is already saved",
    "ui.pickedRememberSave": "{provider}: {model} — remember to save",
    "ui.finishingSetup": "{provider} is not set up yet — finishing setup for it",
    "ui.providerReady": "Provider “{id}” is ready",
    "ui.noMatch": "Nothing matched. Try a shorter word.",
    "ui.noRecommendations": "No recommendations returned by the server.",
    "ui.noSavedIds": "No saved model ids yet for this provider.",
    "ui.notTermux": "Not running under Termux — Android-only checks are skipped.",
    "ui.getApiKey": "Get an API key",
    "ui.manualBaseUrl": "needs a manual base URL",

    // -------------------------------------------------------------- the plan
    "todo.title": "Plan",
    "todo.progress": "{done} of {total} done",
    "todo.status.pending": "to do",
    "todo.status.in_progress": "in progress",
    "todo.status.done": "done",

    // ------------------------------------------------------------ Power tab
    "power.allGood": "Everything in this tier is ready.",
    "power.installed": "Installed: {title}",
    "power.installFailed": "Install failed. Details below.",
    "power.installLog": "Details",
    "power.privSection": "Elevated privileges",
    "power.chooseMethod": "Choose how to grant them:",
    "power.step": "Step {n} of {total}",
    "power.applied": "Applied {ok} of {total} unlocks",
    "power.appliedAll": "Unlocked. The agent can spawn as many processes as it needs.",
    "power.appliedSome": "Some unlocks were refused. Some vendors block appops even over ADB; the first one is what matters.",
    "power.rebootWarn": "Wireless ADB pairing is lost when the phone reboots. Come back here after a restart.",

    "power.coreOk": "Foundation complete",
    "power.coreOkNote": "{n} things ready — the install command handled all of it.",
    "power.repair": "Repair the install ({n})",
    "power.repairNote":
      "{n} things the install command should have set up are missing. Usually that means it was interrupted.",
    "power.installAll": "Install all ({n} · {mb} MB)",
    "power.confirmSize": "Download about {mb} MB?\n\nIt will use mobile data if you are not on Wi-Fi.",
    "power.progressTitle": "Installing",
    "power.progressItem": "{n} of {total} · {title}",
    "power.phase.download": "downloading…",
    "power.phase.unpack": "unpacking…",
    "power.phase.configure": "configuring…",
    "power.phase.start": "starting…",
    "power.installedN": "Installed {n} things.",
    "power.failedAt": "Failed at: {title}",
    "power.busy": "Another install is already running — wait for it to finish.",

    "priv.pair.installAdb": "Install android-tools",
    "priv.pair.s1.title": "Turn on Wireless debugging",
    "priv.pair.s1.body":
      "Settings → Developer options → Wireless debugging → on. No Developer options? Settings → About phone → tap “Build number” seven times.",
    "priv.pair.s1.done": "It's on, next →",
    "priv.pair.s2.title": "Enter the pairing code",
    "priv.pair.s2.body":
      "Tap “Pair device with pairing code”. It shows an IP:PORT and a 6-digit code. This port is NOT the one on the main screen.",
    "priv.pair.addrLabel": "Pairing IP:PORT",
    "priv.pair.codeLabel": "6-digit code",
    "priv.pair.paired": "Paired.",
    "priv.pair.s3.title": "Connect",
    "priv.pair.s3.body": "Go back to the main Wireless debugging screen and read the IP:PORT there — a different port from the pairing one.",
    "priv.pair.connectLabel": "Connect IP:PORT",
    "priv.pair.doConnect": "Connect and unlock",

    "priv.shizuku.s1": "Install the Shizuku app from F-Droid or Google Play.",
    "priv.shizuku.s2": "Open it and press Start. Shizuku does its own pairing, once.",
    "priv.shizuku.s3": "In Shizuku choose “Use Shizuku in terminal apps” → export the files to Download.",
    "priv.shizuku.s4": "Copy those two files into Termux, then press check.",
    "priv.shizuku.copy": "Copy the rish files from Download",
    "priv.shizuku.copied": "Copied. Press check.",
    "priv.shizuku.check": "Check rish",
    "priv.shizuku.storageFirst": "Storage permission is needed first. Run termux-setup-storage in Termux.",

    "priv.root.check": "Try su",
    "priv.handledByCli":
      "Every `nhatnam` looks for privileges and applies them itself. If you grant ADB from another Termux window it will pick that up within 20 seconds - no restart needed.",
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
