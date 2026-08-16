#!/usr/bin/env bash
# =============================================================================
# TCA (Termux Coding Agent) - One-shot setup script
# Chạy lệnh này trong Termux để cài đặt toàn bộ:
#   curl -fsSL https://raw.githubusercontent.com/nhatnam2009/tca/main/install.sh | bash
# hoặc nếu copy file này vào Termux:
#   bash install.sh
# =============================================================================

set -e

BOLD="\e[1m"
GREEN="\e[32m"
YELLOW="\e[33m"
RED="\e[31m"
CYAN="\e[36m"
RESET="\e[0m"

step() { echo -e "\n${BOLD}${CYAN}==> $1${RESET}"; }
ok()   { echo -e "${GREEN}[ok]${RESET} $1"; }
warn() { echo -e "${YELLOW}[!]${RESET}  $1"; }
die()  { echo -e "${RED}[!!]${RESET} $1"; exit 1; }

# When this script is piped into bash (curl ... | bash) stdin is the script
# itself, not the keyboard. Read questions from the terminal directly, and
# answer "no" if there is no terminal at all.
ask() {
  local reply=""
  printf '%s' "$1"
  if { read -r reply < /dev/tty; } 2>/dev/null; then
    printf '\n'
  else
    reply=""
    printf '(không có terminal - mặc định: không)\n'
  fi
  case "$(printf '%s' "$reply" | tr '[:upper:]' '[:lower:]')" in
    y | yes) return 0 ;;
    *) return 1 ;;
  esac
}

echo -e "${BOLD}"
echo "╔══════════════════════════════════════╗"
echo "║   TCA - Termux Coding Agent Setup   ║"
echo "╚══════════════════════════════════════╝"
echo -e "${RESET}"

# ── 0. Kiểm tra môi trường ───────────────────────────────────────────────────
if [ -z "${TERMUX_VERSION:-}" ] || [ -z "${PREFIX:-}" ]; then
  die "install.sh chỉ dùng cho Termux trên Android.\nTrên máy tính hãy chạy: bash setup.sh"
fi

# ── 1. Termux packages ───────────────────────────────────────────────────────
step "Cập nhật Termux & cài packages cần thiết"

# apt hỏi "sources.list đã bị sửa, giữ bản nào?" và nếu stdin là pipe thì nó
# nhận EOF rồi bỏ dở gói apt. --force-confold = luôn giữ file của bạn.
export DEBIAN_FRONTEND=noninteractive
KEEP_CONF=(-o "Dpkg::Options::=--force-confold" -o "Dpkg::Options::=--force-confdef")

# Hoàn tất gói cài dở từ lần chạy trước (no-op nếu không có gì dở dang).
dpkg --configure -a --force-confold >/dev/null 2>&1 || true

apt-get update -y "${KEEP_CONF[@]}" || warn "apt update không xong, vẫn thử cài tiếp"
# Nâng cấp là khuyến nghị của Termux (node được build với libc++ mới hơn), nhưng
# một gói lẻ bị lỗi không được phép làm chết cả script.
apt-get upgrade -y "${KEEP_CONF[@]}" || warn "apt upgrade không xong, vẫn thử cài tiếp"

apt-get install -y "${KEEP_CONF[@]}" nodejs git \
  || die "Không cài được nodejs/git.\n  Thử: pkg install nodejs git"

command -v node >/dev/null || die "node vẫn không có sau khi cài. Chạy: pkg install nodejs"
command -v git  >/dev/null || die "git vẫn không có sau khi cài. Chạy: pkg install git"

# node có thể cài được nhưng không chạy: đó là lỗi libc++ của Termux, không phải
# lỗi của dự án này. Phân biệt rõ để bạn không đi sửa sai chỗ.
NODE_PROBE="$(node -p 'process.versions.node' 2>&1)" || NODE_BROKEN=1
if [ -n "${NODE_BROKEN:-}" ]; then
  echo -e "${RED}[!!]${RESET} node đã cài nhưng không chạy được:"
  echo "     $NODE_PROBE"
  case "$NODE_PROBE" in
    *"CANNOT LINK EXECUTABLE"* | *"cannot locate symbol"*)
      echo ""
      echo "  Đây là lỗi lệch thư viện của Termux. Sửa bằng:"
      echo "    pkg update && pkg upgrade -y"
      echo "  Vẫn lỗi thì:"
      echo "    pkg reinstall libc++ nodejs"
      echo ""
      echo "  Nếu vẫn lỗi: bản Termux trên Google Play đã bị bỏ và repo của nó hỏng."
      echo "  Hãy cài Termux từ F-Droid hoặc GitHub releases."
      ;;
  esac
  exit 1
fi

if [ "${NODE_PROBE%%.*}" -lt 20 ]; then
  die "Cần Node 20+, đang có v$NODE_PROBE.\n  Chạy: pkg upgrade nodejs"
fi

ok "Node v$NODE_PROBE | git $(git --version | awk '{print $3}')"

# ── 2. Clone hoặc pull repo ──────────────────────────────────────────────────
TCA_DIR="$HOME/tca"
# Đổi TCA_REPO nếu bạn fork sang chỗ khác: TCA_REPO=<url> bash install.sh
TCA_REPO="${TCA_REPO:-https://github.com/nhatnam2009/tca.git}"

step "Cài đặt TCA vào $TCA_DIR"
if [ -f "./src/cli.js" ]; then
  # Đang chạy từ trong thư mục TCA rồi (trường hợp giải nén zip) - dùng luôn.
  TCA_DIR="$(pwd)"
  ok "Đang dùng thư mục hiện tại: $TCA_DIR"
elif [ -d "$TCA_DIR/.git" ]; then
  warn "Thư mục $TCA_DIR đã tồn tại, tiến hành cập nhật..."
  git -C "$TCA_DIR" pull --ff-only
  ok "Đã cập nhật lên phiên bản mới nhất"
elif [ -f "$TCA_DIR/src/cli.js" ]; then
  ok "Đã có sẵn source tại $TCA_DIR"
else
  git clone "$TCA_REPO" "$TCA_DIR"
  ok "Đã clone từ $TCA_REPO"
fi

# ── 3. Link CLI toàn cục ─────────────────────────────────────────────────────
step "Link lệnh 'tca' vào PATH"
cd "$TCA_DIR"
chmod +x "$TCA_DIR/src/cli.js"
# npm link cần quyền write vào prefix và khá chậm trên điện thoại; symlink là đủ.
mkdir -p "$PREFIX/bin"
ln -sf "$TCA_DIR/src/cli.js" "$PREFIX/bin/tca"
# 'nhatnam' không tham số = 'tca serve', cho nhanh khi gõ trên điện thoại.
cat > "$PREFIX/bin/nhatnam" <<EOF
#!$PREFIX/bin/sh
if [ "\$#" -eq 0 ]; then
  exec node "$TCA_DIR/src/cli.js" serve
else
  exec node "$TCA_DIR/src/cli.js" "\$@"
fi
EOF
chmod +x "$PREFIX/bin/nhatnam"
ok "Lệnh 'tca' đã sẵn sàng: $(command -v tca || echo "$PREFIX/bin/tca")"
ok "Gõ 'nhatnam' (không tham số) để khởi động agent ngay"

# ── 4. Xin quyền Shared Storage (để Termux đọc ghi thư mục Downloads) ───────
step "Kiểm tra Shared Storage"
if [ ! -d "$HOME/storage/shared" ]; then
  warn "Chưa cấp quyền lưu trữ. Đang xin quyền..."
  termux-setup-storage
  sleep 2
else
  ok "Shared storage đã được cấp quyền"
fi

# ── 5. Wake lock (ngăn Android kill tiến trình khi khoá màn hình) ────────────
step "Bật Wake Lock"
if command -v termux-wake-lock &>/dev/null; then
  termux-wake-lock
  ok "Wake lock đã bật (daemon không bị Android kill)"
else
  warn "termux-wake-lock không có. Cài Termux:API app + 'pkg install termux-api'"
fi

# ── 6. Tự động detect API key trong environment ──────────────────────────────
step "Kiểm tra API keys trong môi trường"
# Hỏi thẳng src/providers.js thay vì tự liệt kê tên biến: danh sách env var
# nằm ở một chỗ duy nhất nên không bao giờ lệch (GEMINI_API_KEY, ZAI_API_KEY, …).
DETECTED="$(node --input-type=module -e \
  "import { detectFromEnv } from './src/providers.js'; console.log(detectFromEnv().map((e) => e.envName).join(', '));" \
  2>/dev/null || true)"

if [ -n "$DETECTED" ]; then
  ok "Tìm thấy API key: $DETECTED"
  ok "Sẽ được tự động cấu hình khi chạy 'tca serve'"
else
  warn "Không thấy API key nào trong environment."
  warn "Bạn sẽ cấu hình provider trong web UI sau."
  warn "Hoặc export key trước, ví dụ:"
  warn "  export ANTHROPIC_API_KEY=sk-ant-..."
fi

# ── 7. Chạy doctor check ─────────────────────────────────────────────────────
step "Kiểm tra hệ thống (tca doctor)"
# doctor trả exit code 1 khi còn việc cần sửa; đó là thông tin, không phải lỗi
# cài đặt, nên đừng để 'set -e' dừng script ở đây.
tca doctor || true

# ── 8. Hỏi có muốn setup ADB không ─────────────────────────────────────────
step "ADB Privilege Setup (tuỳ chọn - khuyên dùng)"
echo ""
echo "  ADB setup sẽ unlock các giới hạn Android:"
echo "    - Phantom process limit (ngăn Android kill shell commands của agent)"
echo "    - Doze whitelist (agent không bị Android tắt khi khoá màn hình)"
echo "    - Background activity + wake lock cho Termux"
echo ""
if ask "  Bạn có muốn setup ADB ngay bây giờ không? [y/N] "; then
  # adb-setup hỏi qua readline trên stdin, nên phải nối nó vào terminal thật.
  if [ -r /dev/tty ]; then
    tca adb-setup < /dev/tty || warn "ADB setup chưa xong. Chạy lại sau bằng: tca adb-setup"
  else
    warn "Không có terminal để chạy adb-setup. Chạy sau bằng: tca adb-setup"
  fi
else
  warn "Bỏ qua ADB setup. Có thể chạy sau bất kỳ lúc nào bằng: tca adb-setup"
fi

# ── 9. Tạo alias tiện lợi ────────────────────────────────────────────────────
step "Thêm alias hữu ích vào ~/.bashrc"
BASHRC="$HOME/.bashrc"
if ! grep -q "# tca aliases" "$BASHRC" 2>/dev/null; then
  cat >> "$BASHRC" << 'EOF'

# tca aliases
alias tca-start='tca serve'
alias tca-url='tca token'
alias tca-adb='tca adb-setup'
# Mở URL trong trình duyệt Termux (nếu có termux-open-url)
alias tca-open='tca-start & sleep 2 && termux-open-url "$(tca token)" 2>/dev/null || echo "Mở: $(tca token)"'
EOF
  ok "Đã thêm aliases: tca-start, tca-url, tca-adb, tca-open"
else
  ok "Aliases đã tồn tại trong ~/.bashrc"
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}✓ Setup hoàn tất!${RESET}"
echo ""
echo -e "  ${BOLD}Khởi động TCA:${RESET}"
echo "    tca serve"
echo ""
echo -e "  ${BOLD}Xem URL truy cập:${RESET}"
echo "    tca token"
echo ""
echo -e "  ${BOLD}Mở trong trình duyệt (sau khi start):${RESET}"
echo "    termux-open-url \"\$(tca token)\""
echo ""
echo -e "  ${BOLD}Chạy tác vụ từ terminal:${RESET}"
echo "    tca run \"viết cho tôi một hello world bằng Python\""
echo ""
echo -e "  ${BOLD}Kiểm tra hệ thống:${RESET}"
echo "    tca doctor"
echo ""
warn "Mở một tab Termux mới (hoặc chạy 'source ~/.bashrc') để dùng các alias vừa thêm."
