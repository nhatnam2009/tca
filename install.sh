#!/usr/bin/env bash
# =============================================================================
# TCA (Termux Coding Agent) - cài đặt bằng MỘT lệnh.
#
#   pkg install -y curl && curl -fsSL https://raw.githubusercontent.com/nhatnam2009/tca/main/install.sh | bash
#
# Hoặc nếu đã có source:
#   bash install.sh
#
# Script này KHÔNG hỏi gì cả. Mọi thứ tương tác (ghép nối ADB, Shizuku, chọn
# model) đã chuyển vào web UI, vì bấm nút trên điện thoại dễ hơn gõ lệnh nhiều.
#
# Chạy lại bao nhiêu lần cũng được: mọi bước đều idempotent, không xoá gì.
# =============================================================================

set -uo pipefail

BOLD="\e[1m"; DIM="\e[2m"; GREEN="\e[32m"; YELLOW="\e[33m"; RED="\e[31m"; CYAN="\e[36m"; RESET="\e[0m"
step() { echo -e "\n${BOLD}${CYAN}==>${RESET} ${BOLD}$1${RESET}"; }
ok()   { echo -e "  ${GREEN}✓${RESET} $1"; }
warn() { echo -e "  ${YELLOW}!${RESET} $1"; }
info() { echo -e "  ${DIM}$1${RESET}"; }
die()  { echo -e "\n${RED}✗ $1${RESET}\n" >&2; exit 1; }

in_termux() { [ -n "${TERMUX_VERSION:-}" ] && [ -n "${PREFIX:-}" ]; }

echo -e "${BOLD}"
echo "  ╔════════════════════════════════════╗"
echo "  ║   TCA · coding agent cho Termux    ║"
echo "  ╚════════════════════════════════════╝"
echo -e "${RESET}"

# ─── 1. Gói hệ thống ─────────────────────────────────────────────────────────

if in_termux; then
  step "Cài gói hệ thống"

  # apt sẽ hỏi "sources.list đã bị sửa, giữ bản nào?" và khi script được pipe
  # vào bash thì stdin là chính script, nên dpkg nhận EOF rồi bỏ dở gói apt.
  # --force-confold = luôn giữ file của bạn, không hỏi.
  export DEBIAN_FRONTEND=noninteractive
  KEEP=(-o "Dpkg::Options::=--force-confold" -o "Dpkg::Options::=--force-confdef")

  # Hoàn tất gói cài dở từ lần trước (no-op nếu không có gì dở dang).
  dpkg --configure -a --force-confold >/dev/null 2>&1 || true

  info "đang cập nhật danh sách gói…"
  apt-get update -y "${KEEP[@]}" >/dev/null 2>&1 || warn "apt update không xong, vẫn thử tiếp"

  # Nâng cấp trước khi cài nodejs: node được build với libc++ mới hơn, cài lẻ
  # trên hệ thống cũ là gặp "CANNOT LINK EXECUTABLE" ngay.
  info "đang nâng cấp hệ thống (có thể mất vài phút)…"
  apt-get upgrade -y "${KEEP[@]}" >/dev/null 2>&1 || warn "apt upgrade không xong, vẫn thử tiếp"

  # nodejs+git là bắt buộc. Còn lại làm agent mạnh hơn rõ rệt và đều rất nhẹ:
  #   ripgrep  tool grep nhanh hơn nhiều lần thay vì tự đọc file bằng JS
  #   fd       tool glob nhanh hơn
  #   termux-api  wake lock + thông báo khi agent xong việc
  #   jq       nhiều lệnh agent hay dùng cần nó
  REQUIRED=(nodejs git)
  EXTRAS=(ripgrep fd termux-api jq termux-services)

  # Tên gói Termux có đổi theo thời gian. Gói nào không tồn tại thì bỏ qua kèm
  # cảnh báo, chứ không làm sập cả lần cài.
  WANT=()
  for pkg in "${REQUIRED[@]}" "${EXTRAS[@]}"; do
    if apt-cache show "$pkg" >/dev/null 2>&1; then
      WANT+=("$pkg")
    else
      warn "không có gói '$pkg' trong repo này, bỏ qua"
    fi
  done

  info "đang cài: ${WANT[*]}"
  if ! apt-get install -y "${KEEP[@]}" "${WANT[@]}" >/dev/null 2>&1; then
    warn "cài cả lượt thất bại, thử từng gói…"
    for pkg in "${WANT[@]}"; do
      apt-get install -y "${KEEP[@]}" "$pkg" >/dev/null 2>&1 && ok "$pkg" || warn "$pkg thất bại"
    done
  fi
  ok "xong phần gói"
else
  step "Không phải Termux — bỏ qua cài gói"
  info "Hãy tự đảm bảo có node 20+ và git trên PATH."
fi

# ─── 2. Kiểm tra node ────────────────────────────────────────────────────────

step "Kiểm tra Node.js"
command -v node >/dev/null || die "Không có node.$(in_termux && echo '
  Chạy: pkg install nodejs')"
command -v git >/dev/null || warn "Không có git — agent vẫn chạy nhưng bạn sẽ khó quay lại bản cũ."

# Ba kiểu lỗi khác nhau, và phân biệt được chúng rất quan trọng: "chưa cài",
# "cài rồi nhưng thư viện lệch" (rất hay gặp trên Termux), và "quá cũ".
if ! NODE_V="$(node -p 'process.versions.node' 2>&1)"; then
  echo -e "\n${RED}✗ node đã cài nhưng không chạy được:${RESET}" >&2
  echo "    $NODE_V" >&2
  case "$NODE_V" in
    *"CANNOT LINK EXECUTABLE"* | *"cannot locate symbol"*)
      cat >&2 <<'DIAG'

  Đây là lỗi lệch thư viện của Termux, không phải lỗi của dự án này. Binary node
  được build với libc++ mới hơn bản đang cài — xảy ra khi cài nodejs mà chưa
  nâng cấp hệ thống trước.

  Sửa:
    pkg update && pkg upgrade -y
    node -v

  Vẫn lỗi:
    pkg reinstall libc++ nodejs

  Vẫn lỗi nữa: kiểm tra Termux đến từ đâu bằng  termux-info | head -20
  Bản Termux trên Google Play đã bị bỏ và repo của nó hỏng. Hãy cài Termux từ
  F-Droid hoặc từ GitHub releases.
DIAG
      ;;
  esac
  exit 1
fi

[ "${NODE_V%%.*}" -ge 20 ] || die "Cần Node 20+, đang có v$NODE_V.
  Chạy: pkg upgrade nodejs"
ok "node v$NODE_V"
info "không cần npm install — dự án này không có dependency nào"

# ─── 3. Source code ──────────────────────────────────────────────────────────

step "Source code"
TCA_REPO="${TCA_REPO:-https://github.com/nhatnam2009/tca.git}"
SELF_DIR=""
# BASH_SOURCE trỏ tới /dev/stdin khi script được pipe vào bash, nên chỉ tin nó
# khi nó thật sự là một file có src/cli.js bên cạnh.
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
fi

if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/src/cli.js" ]; then
  TCA_DIR="$SELF_DIR"
  ok "dùng thư mục hiện có: $TCA_DIR"
elif [ -f "./src/cli.js" ]; then
  TCA_DIR="$(pwd)"
  ok "dùng thư mục hiện tại: $TCA_DIR"
else
  TCA_DIR="$HOME/tca"
  if [ -d "$TCA_DIR/.git" ]; then
    info "đang cập nhật $TCA_DIR…"
    git -C "$TCA_DIR" pull --ff-only >/dev/null 2>&1 && ok "đã cập nhật" || warn "pull không xong, dùng bản đang có"
  elif [ -f "$TCA_DIR/src/cli.js" ]; then
    ok "đã có sẵn tại $TCA_DIR"
  else
    command -v git >/dev/null || die "Cần git để tải source. Chạy: pkg install git"
    info "đang clone $TCA_REPO…"
    git clone --depth 1 "$TCA_REPO" "$TCA_DIR" >/dev/null 2>&1 || die "Clone thất bại. Kiểm tra mạng."
    ok "đã clone vào $TCA_DIR"
  fi
fi
cd "$TCA_DIR"

# ─── 4. Lệnh tca và nhatnam ──────────────────────────────────────────────────

step "Tạo lệnh"
chmod +x "$TCA_DIR/src/cli.js" 2>/dev/null || true

if in_termux; then
  BIN="$PREFIX/bin"
else
  # Trên máy tính: chỗ nào trong PATH và ghi được thì dùng.
  BIN="$HOME/.local/bin"
  mkdir -p "$BIN"
fi
mkdir -p "$BIN"

ln -sf "$TCA_DIR/src/cli.js" "$BIN/tca"
# 'nhatnam' không tham số = khởi động agent. Gõ nhanh, và đó là lệnh duy nhất
# người dùng cần nhớ.
cat > "$BIN/nhatnam" <<EOF
#!/usr/bin/env sh
# Do install.sh tạo. Không tham số = khởi động agent.
if [ "\$#" -eq 0 ]; then
  exec node "$TCA_DIR/src/cli.js" serve
else
  exec node "$TCA_DIR/src/cli.js" "\$@"
fi
EOF
chmod +x "$BIN/nhatnam"
ok "tca + nhatnam → $BIN"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) warn "$BIN chưa có trong PATH. Thêm vào ~/.bashrc: export PATH=\"\$PATH:$BIN\"" ;;
esac

# ─── 5. Thư mục làm việc ─────────────────────────────────────────────────────

step "Thư mục làm việc"
WORKSPACE="${TCA_WORKSPACE:-$HOME/projects}"
mkdir -p "$WORKSPACE"
ok "$WORKSPACE"
# Có git thì một lần sửa sai của agent chỉ cách bạn một lệnh 'git checkout --'.
if command -v git >/dev/null && [ ! -d "$WORKSPACE/.git" ]; then
  git -C "$WORKSPACE" init -q 2>/dev/null && info "đã git init (để hoàn tác được khi agent sửa sai)" || true
fi

# ─── 6. Quyền bộ nhớ ─────────────────────────────────────────────────────────

if in_termux; then
  step "Quyền bộ nhớ"
  if [ -d "$HOME/storage/shared" ]; then
    ok "đã được cấp"
  else
    info "đang xin quyền — bấm Cho phép trên hộp thoại Android"
    termux-setup-storage >/dev/null 2>&1 || true
    sleep 3
    if [ -d "$HOME/storage/shared" ]; then
      ok "đã được cấp"
    else
      warn "chưa được cấp — config sẽ nằm ở ~/.tca/config.json (vẫn chạy bình thường)"
      warn "cấp sau bằng: termux-setup-storage"
    fi
  fi
fi

# ─── 7. Service tự sống lại ──────────────────────────────────────────────────

if in_termux && command -v sv >/dev/null; then
  step "Service tự khởi động lại"
  SV_DIR="$PREFIX/var/service/tca"
  mkdir -p "$SV_DIR/log"
  cat > "$SV_DIR/run" <<EOF
#!$PREFIX/bin/sh
# Do install.sh tạo.
exec 2>&1
cd "$TCA_DIR"
exec node "$TCA_DIR/src/cli.js" serve
EOF
  cat > "$SV_DIR/log/run" <<EOF
#!$PREFIX/bin/sh
mkdir -p "$PREFIX/var/log/tca"
exec svlogd -tt "$PREFIX/var/log/tca"
EOF
  chmod +x "$SV_DIR/run" "$SV_DIR/log/run"
  ok "đã cài service (daemon sống lại nếu Android kill Termux)"
  info "bật:  sv-enable tca      ·  log:  tail -f $PREFIX/var/log/tca/current"
  info "wake lock giờ do chính 'tca serve' tự giữ, không cần bước riêng"
fi

# ─── 8. Tạo config lần đầu ───────────────────────────────────────────────────

step "Cấu hình"
node "$TCA_DIR/src/cli.js" token >/dev/null 2>&1 || true
ok "đã tạo config"

# ─── 9. Xong ─────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}${GREEN}  ✓ Cài đặt hoàn tất${RESET}"
echo ""
if in_termux; then
  echo -e "  ${BOLD}Gõ:${RESET}  ${BOLD}${GREEN}nhatnam${RESET}"
  echo ""
  info "rồi mở đường link nó in ra trong Chrome."
  info "Mở tab Power trong web UI để cấp thêm quyền cho agent mạnh nhất."
else
  echo -e "  ${BOLD}Gõ:${RESET}  ${BOLD}${GREEN}tca serve${RESET}"
  echo ""
  info "rồi mở đường link nó in ra trong trình duyệt."
fi
echo ""
