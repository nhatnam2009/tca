#!/usr/bin/env bash
# =============================================================================
# TCA (Termux Coding Agent) - One-shot setup script
# Chạy lệnh này trong Termux để cài đặt toàn bộ:
#   curl -fsSL https://raw.githubusercontent.com/you/tca/main/install.sh | bash
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
pkg update -y
pkg upgrade -y
pkg install -y nodejs git

ok "Node $(node --version) | git $(git --version | awk '{print $3}')"

# ── 2. Clone hoặc pull repo ──────────────────────────────────────────────────
TCA_DIR="$HOME/tca"

step "Cài đặt TCA vào $TCA_DIR"
if [ -f "./src/cli.js" ]; then
  # Đang chạy từ trong thư mục TCA rồi (trường hợp giải nén zip) - dùng luôn.
  TCA_DIR="$(pwd)"
  ok "Đang dùng thư mục hiện tại: $TCA_DIR"
elif [ -d "$TCA_DIR/.git" ]; then
  warn "Thư mục $TCA_DIR đã tồn tại, tiến hành cập nhật..."
  git -C "$TCA_DIR" pull --ff-only
  ok "Đã cập nhật lên phiên bản mới nhất"
elif [ -n "${TCA_REPO:-}" ]; then
  git clone "$TCA_REPO" "$TCA_DIR"
  ok "Đã clone từ $TCA_REPO"
elif [ -f "$TCA_DIR/src/cli.js" ]; then
  ok "Đã có sẵn source tại $TCA_DIR"
else
  die "Không tìm thấy source code TCA.\nExport biến TCA_REPO=<url> hoặc chạy script này từ trong thư mục tca/"
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
read -r -p "  Bạn có muốn setup ADB ngay bây giờ không? [y/N] " adb_choice
if [[ "${adb_choice,,}" == "y" || "${adb_choice,,}" == "yes" ]]; then
  tca adb-setup || warn "ADB setup chưa xong. Chạy lại sau bằng: tca adb-setup"
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
