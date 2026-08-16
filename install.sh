#!/usr/bin/env bash
# =============================================================================
# TCA (Termux Coding Agent) - cài đặt bằng MỘT lệnh.
#
#   curl -fsSL https://raw.githubusercontent.com/nhatnam2009/tca/main/install.sh | bash
#
# ĐỪNG chạy 'pkg install curl' trước. Termux mới đã có curl sẵn, và cài lẻ một
# gói trên hệ thống chưa nâng cấp sẽ kéo về bản mới build với thư viện mới hơn
# phần còn lại của hệ thống — làm chính curl không chạy được nữa:
#   CANNOT LINK EXECUTABLE "curl": cannot locate symbol "nghttp2_..."
# Script này nâng cấp toàn bộ hệ thống TRƯỚC rồi mới cài gì, đúng thứ tự đó.
#
# Nếu curl bị lỗi kiểu trên rồi, sửa bằng:
#   pkg upgrade -y -o Dpkg::Options::=--force-confold
#
# Hoặc nếu đã có source:
#   bash install.sh
#
# Script này KHÔNG hỏi gì cả, và cũng không có gì để hỏi: việc duy nhất cần
# người là ghép nối ADB, và `nhatnam` hỏi việc đó lúc khởi động lần đầu.
#
# Chạy lại bao nhiêu lần cũng được: mọi bước đều idempotent, không xoá gì.
#
# ─────────────────────────────────────────────────────────────────────────────
# MỌI lệnh ngoài trong file này phải có `</dev/null`. Không phải để cho gọn.
#
# Script này chạy bằng `curl … | bash`, nên **stdin của nó chính là phần script
# chưa đọc tới**. Bất kỳ lệnh nào đọc stdin sẽ ăn mất đoạn script còn lại, và
# bash không báo lỗi gì cả — nó chỉ đơn giản hết chữ để chạy rồi thoát êm.
#
# Đúng như thế đã xảy ra trên máy thật: apt cài xong, libcurl sửa xong, clone
# xong, in ra `==> Tạo lệnh` rồi im lặng dừng luôn. Không lỗi, không exit code,
# chỉ là bốn bước cuối biến mất. Và nó không xảy ra mọi lần — ăn được bao nhiêu
# còn tuỳ buffer và tuỳ curl đã stream tới đâu, nên lần chạy trước đó vẫn xong
# bình thường. Một lỗi mà chạy lại là hết thì rất khó truy.
#
# `</dev/null` làm chuyện đó thành không thể. Rẻ, và không có mặt trái.
# ─────────────────────────────────────────────────────────────────────────────
# =============================================================================

set -uo pipefail

BOLD="\e[1m"; DIM="\e[2m"; GREEN="\e[32m"; YELLOW="\e[33m"; RED="\e[31m"; CYAN="\e[36m"; RESET="\e[0m"
step() { echo -e "\n${BOLD}${CYAN}==>${RESET} ${BOLD}$1${RESET}"; }
ok()   { echo -e "  ${GREEN}✓${RESET} $1"; }
warn() { echo -e "  ${YELLOW}!${RESET} $1"; }
info() { echo -e "  ${DIM}$1${RESET}"; }
die()  { echo -e "\n${RED}✗ $1${RESET}\n" >&2; exit 1; }

in_termux() { [ -n "${TERMUX_VERSION:-}" ] && [ -n "${PREFIX:-}" ]; }

# Byte -> chuỗi người đọc được. Có vì con số duy nhất apt đưa ra chắc chắn đúng
# là tổng byte của các file .deb, và "412430336" không nói với ai điều gì.
human_bytes() {
  awk -v b="${1:-0}" 'BEGIN {
    if (b >= 1073741824) printf "%.1f GB", b / 1073741824;
    else if (b >= 1048576) printf "%.0f MB", b / 1048576;
    else if (b >= 1024) printf "%.0f kB", b / 1024;
    else printf "%d B", b;
  }'
}

# ── Lỗi lệch thư viện của Termux ─────────────────────────────────────────────
#
# Đây là cách hỏng phổ biến nhất trên Termux, và nó KHÔNG phải lỗi của dự án
# này: một gói được cài lẻ trên hệ thống cũ sẽ link tới symbol chưa có trong
# thư viện đang cài. Binary tồn tại, `command -v` thấy nó, nhưng chạy là chết.
# Kiểm tra riêng, và nói rõ ra, thay vì để nó biểu hiện thành một lỗi khác.
#
# $1 = tên lệnh, $2 = tham số để thử chạy
check_runs() {
  local bin="$1" probe="${2:---version}" out
  command -v "$bin" >/dev/null || return 0   # chưa cài là chuyện khác
  if out="$("$bin" $probe 2>&1)"; then return 0; fi
  case "$out" in
    *"CANNOT LINK EXECUTABLE"* | *"cannot locate symbol"* | *"library"*"not found"*)
      echo -e "\n${RED}✗ '$bin' đã cài nhưng không chạy được:${RESET}" >&2
      echo "    $(echo "$out" | head -1)" >&2
      cat >&2 <<DIAG

  Đây là lỗi lệch thư viện của Termux, không phải lỗi của dự án này. Gói '$bin'
  là bản mới, nhưng thư viện nó cần thì vẫn là bản cũ — xảy ra khi cài lẻ một
  gói mà chưa nâng cấp toàn hệ thống trước.

  Sửa:
    pkg upgrade -y -o Dpkg::Options::=--force-confold

  Vẫn lỗi thì cài lại chính nó cùng thư viện:
    pkg reinstall $bin

DIAG
      return 1
      ;;
  esac
  return 0
}

#
# apt tự nó có chạy được không?
#
# Đây là chế độ hỏng tệ nhất của Termux, và nó không tự nói ra: một lần
# `pkg upgrade` đứt giữa transaction sẽ để libapt-pkg ở bản mới trong khi thư
# viện nó cần vẫn là bản cũ, và từ đó apt chết:
#
#   CANNOT LINK EXECUTABLE "apt": library "liblz4.so.1" not found:
#     needed by .../lib/libapt-pkg.so
#
# Khi đó KHÔNG sửa được bằng pkg hay apt — chính công cụ để sửa đã chết. Lời
# khuyên "chạy pkg upgrade" của check_runs() là vô nghĩa ở đây, nên có riêng
# một thông báo cho trường hợp này.
apt_broken() {
  local out
  out="$(apt-get --version 2>&1 </dev/null)" && return 1
  case "$out" in
    *"CANNOT LINK EXECUTABLE"* | *"cannot locate symbol"* | *"library"*"not found"*) return 0 ;;
  esac
  return 1
}

#
# Termux kiến trúc nào, theo tên mà repo dùng.
termux_arch() {
  case "$(uname -m)" in
    aarch64) echo aarch64 ;;
    armv7l | armv8l | arm) echo arm ;;
    i686 | i386) echo i686 ;;
    x86_64) echo x86_64 ;;
    *) echo "" ;;
  esac
}

#
# Tự sửa một apt đã chết.
#
# Lý do tồn tại: mục tiêu của dự án này là MỘT lệnh rồi gõ `nhatnam` là chạy. Một
# script cài chỉ biết bó tay nói "apt hỏng rồi, tự đi sửa đi" thì đã phá mất
# chính lời hứa đó. Và tình huống này không hiếm: `pkg upgrade` đứt giữa
# transaction là chuyện xảy ra thật, chỉ cần mất mạng giữa đường hoặc mirror lệch
# nhau là đủ.
#
# Chuỗi sửa, rẻ trước đắt sau:
#
#   1. Còn file .so không? Thường libX.so.1.2.3 vẫn nằm đó và chỉ mất symlink
#      soname libX.so.1. Tạo lại link là xong — không cần mạng, không cần gì cả.
#   2. Không còn thì tải .deb về và đặt bằng dpkg. dpkg KHÔNG link tới libapt-pkg
#      nên nó thường vẫn sống khi apt đã chết; đường dẫn .deb tra từ chính file
#      Packages của repo, để không phải đoán tên hay số phiên bản.
#
# Chỉ chạy khi apt đã xác nhận hỏng, nên không có gì để làm hỏng thêm.
repair_broken_apt() {
  local attempt lib sofile pkg arch index deb url tmp
  tmp="${TMPDIR:-/tmp}/tca-aptfix.$$"
  mkdir -p "$tmp" || return 1

  # Sửa được thư viện này thì linker có thể lộ ra thư viện thiếu tiếp theo, nên
  # lặp — nhưng có giới hạn, vì một prefix vỡ quá nhiều thì dựng lại nhanh hơn.
  for attempt in 1 2 3 4; do
    apt_broken || { rm -rf "$tmp"; return 0; }

    lib="$(apt-get --version 2>&1 </dev/null | sed -n 's/.*library "\([^"]*\)" not found.*/\1/p' | head -1)"
    [ -n "$lib" ] || break
    info "thiếu thư viện $lib — đang thử tự sửa (lần $attempt)"

    # (1) Chỉ mất symlink.
    sofile="$(ls -1 "$PREFIX/lib/$lib".* 2>/dev/null | head -1)"
    if [ -z "$sofile" ] && [ -e "$PREFIX/lib/${lib%%.so*}.so" ]; then
      sofile="$PREFIX/lib/${lib%%.so*}.so"
    fi
    if [ -n "$sofile" ] && [ ! -e "$PREFIX/lib/$lib" ]; then
      ln -sf "$sofile" "$PREFIX/lib/$lib" 2>/dev/null &&
        ok "đã tạo lại symlink $lib -> $(basename "$sofile")"
      continue
    fi

    # (2) Tải gói về và đặt bằng dpkg.
    if ! command -v dpkg >/dev/null 2>&1 || ! dpkg --version >/dev/null 2>&1 </dev/null; then
      warn "dpkg cũng không chạy được, không tự sửa tiếp được"
      break
    fi
    arch="$(termux_arch)"
    if [ -z "$arch" ]; then
      warn "không nhận ra kiến trúc $(uname -m)"
      break
    fi

    pkg="${lib%%.so*}"
    index="$tmp/Packages"
    if [ ! -s "$index" ]; then
      info "đang tải danh sách gói để tìm $pkg…"
      curl -fsSL --retry 2 --connect-timeout 20 \
        "https://packages.termux.dev/apt/termux-main/dists/stable/main/binary-$arch/Packages.gz" \
        </dev/null 2>/dev/null | gzip -dc >"$index" 2>/dev/null || true
    fi
    if [ ! -s "$index" ]; then
      warn "không tải được danh sách gói (mạng?)"
      break
    fi

    # Khối của gói này trong Packages, rồi lấy trường Filename. awk vì đây là
    # định dạng theo khối cách nhau bằng dòng trắng, không phải theo dòng.
    #
    # Thử cả hai quy ước tên: Termux có gói 'liblz4' nhưng lại có gói 'zstd' chứ
    # không phải 'libzstd', nên đoán một kiểu thôi là sẽ trượt.
    deb=""
    for pkg in "${lib%%.so*}" "${lib#lib}"; do
      pkg="${pkg%%.so*}"
      deb="$(awk -v p="$pkg" '
        /^Package: /   { cur = $2 }
        /^Filename: /  { if (cur == p) { print $2; exit } }
      ' "$index")"
      [ -n "$deb" ] && break
    done
    if [ -z "$deb" ]; then
      warn "không thấy gói nào cung cấp $lib trong danh sách"
      break
    fi

    url="https://packages.termux.dev/apt/termux-main/$deb"
    info "đang tải $pkg…"
    if ! curl -fsSL --retry 2 --connect-timeout 20 -o "$tmp/pkg.deb" "$url" </dev/null 2>/dev/null; then
      warn "tải $pkg thất bại"
      break
    fi
    if dpkg -i --force-confold "$tmp/pkg.deb" </dev/null >/dev/null 2>&1; then
      ok "đã đặt lại $pkg"
    else
      warn "dpkg không đặt được $pkg"
      break
    fi
  done

  rm -rf "$tmp"
  apt_broken && return 1
  return 0
}

die_apt_broken() {
  echo -e "\n${RED}✗ apt của Termux đã hỏng, và tự sửa không được.${RESET}" >&2
  apt-get --version 2>&1 </dev/null | head -1 | sed 's/^/    /' >&2
  cat >&2 <<'DIAG'

  Một lần `pkg upgrade` đã đứt giữa đường: libapt-pkg lên bản mới nhưng thư viện
  nó cần thì chưa. Không sửa được bằng pkg hay apt, vì chính chúng đã chết.

  Cách chắc chắn nhất là dựng lại bootstrap: Cài đặt Android > Ứng dụng > Termux
  > Bộ nhớ > Xoá dữ liệu, mở Termux lại (nó tự bung bootstrap mới), rồi chạy lại
  lệnh cài một dòng. Chỉ mất khoảng một phút.

  Nếu Termux tải từ Google Play: gỡ và cài lại từ F-Droid. Bản trên Play đã bị bỏ
  từ lâu và vỡ đúng kiểu này mỗi lần nâng cấp.

DIAG
  exit 1
}

echo -e "${BOLD}"
echo "  ╔════════════════════════════════════╗"
echo "  ║   TCA · coding agent cho Termux    ║"
echo "  ╚════════════════════════════════════╝"
echo -e "${RESET}"

# ─── 1. Gói hệ thống ─────────────────────────────────────────────────────────

if in_termux; then
  step "Cài gói hệ thống"

  # apt sẽ hỏi "sources.list đã bị sửa, giữ bản nào?", nên --force-confold =
  # luôn giữ file của bạn, không hỏi. Đó là nửa còn lại của vấn đề stdin ở đầu
  # file: nửa này lo việc apt ĐỪNG hỏi, `</dev/null` lo việc nếu nó có hỏi thì
  # cũng không ăn mất script.
  export TERMUX_APP_PACKAGE_MANAGER="${TERMUX_APP_PACKAGE_MANAGER:-apt}"
  export DEBIAN_FRONTEND=noninteractive
  KEEP=(-o "Dpkg::Options::=--force-confold" -o "Dpkg::Options::=--force-confdef")

  if [ ! -x "$PREFIX/bin/termux-setup-package-manager" ]; then
    mkdir -p "$PREFIX/bin"
    printf '#!/bin/sh\necho "apt"\n' > "$PREFIX/bin/termux-setup-package-manager"
    chmod +x "$PREFIX/bin/termux-setup-package-manager" 2>/dev/null || true
  fi

  # Trước khi làm gì khác. Đi tiếp trên một apt đã chết chỉ sinh ra một chuỗi lỗi
  # phái sinh vô nghĩa — "không có gói 'nodejs' trong repo này" khi gói vẫn còn
  # đó, chỉ là apt không đọc được danh sách nữa.
  apt_broken && { repair_broken_apt || die_apt_broken; }

  # Hoàn tất gói cài dở từ lần trước (no-op nếu không có gì dở dang).
  dpkg --configure -a --force-confold </dev/null >/dev/null 2>&1 || true

  info "đang cập nhật danh sách gói…"
  apt-get update -y "${KEEP[@]}" </dev/null >/dev/null 2>&1 || warn "apt update không xong, vẫn thử tiếp"

  # Nâng cấp TOÀN BỘ trước khi cài bất cứ gì. Đây là quy tắc số một của Termux:
  # cài lẻ một gói trên hệ thống cũ sẽ kéo về bản mới link tới symbol chưa có
  # trong thư viện đang cài, và binary đó chết ngay — kể cả curl.
  #
  # Không ẩn output: đây là bước dài nhất và cũng là bước dễ hỏng nhất, nên khi
  # có chuyện bạn phải đọc được nó đã làm gì thay vì chỉ thấy một cảnh báo.
  info "đang nâng cấp hệ thống (bước quan trọng nhất, có thể mất vài phút)…"
  # PIPESTATUS, không phải $?: qua `| tail` thì $? là mã thoát của tail và luôn
  # bằng 0, nên nhánh lỗi ở đây trước giờ gần như không bao giờ chạy — một lần
  # upgrade thất bại vẫn đi tiếp như thể mọi thứ ổn.
  apt-get upgrade -y "${KEEP[@]}" </dev/null 2>&1 | tail -25
  upgrade_rc="${PIPESTATUS[0]}"

  # Kiểm ngay tại đây, vì đây đúng là chỗ apt hay tự giết mình. Bắt ở đây thì
  # thông báo còn dính liền với bước vừa gây ra nó.
  apt_broken && { repair_broken_apt || die_apt_broken; }

  if [ "$upgrade_rc" -ne 0 ]; then
    echo -e "\n${RED}✗ Nâng cấp hệ thống thất bại (mã $upgrade_rc).${RESET}" >&2
    cat >&2 <<'DIAG'

  Dừng ở đây là có chủ ý. Cài gói lên một hệ thống mới nâng cấp nửa vời chính là
  thứ tạo ra lỗi "CANNOT LINK EXECUTABLE" — đi tiếp sẽ làm hỏng thêm, không sửa.

  Thường là mirror đang không đồng bộ. Đổi mirror rồi chạy lại lệnh cài:

    termux-change-repo
    pkg upgrade -y -o Dpkg::Options::=--force-confold

DIAG
    exit 1
  fi

  # Mọi thứ agent cần, cài một lượt. Không còn tab "Sức mạnh" để bấm cài lẻ về
  # sau, nên chỗ này phải cài cho đủ — một lần cài xong là dùng được hết.
  #
  #   nodejs git libcurl ca-certificates  bắt buộc
  #   bash                  shell agent chạy lệnh trong đó
  #   ripgrep               lo cả grep và glob, nhanh hơn đọc file bằng JS nhiều lần
  #   jq                    nhiều lệnh agent hay dùng cần nó
  #   openssh               sshd, để gõ từ máy khác vào
  #   termux-api            wake lock + thông báo khi agent xong việc
  #   termux-services       chạy nền qua sv
  #   android-tools         adb — cần cho ghép nối không dây ở bước sau
  REQUIRED=(nodejs git libcurl ca-certificates)
  TOOLS=(bash ripgrep jq openssh termux-api termux-services android-tools)

  # Nặng, và chỉ cần khi bạn muốn agent chạy/biên dịch code người khác:
  # python ~130MB, clang+make+binutils ~400MB, proot-distro ~5MB.
  # Vẫn cài theo mặc định vì "agent đầy đủ" là điều được yêu cầu — đặt
  # TCA_SKIP_HEAVY=1 nếu bạn đang dùng 4G và muốn bỏ chúng.
  HEAVY=(python clang make binutils proot-distro)
  if [ -n "${TCA_SKIP_HEAVY:-}" ]; then
    HEAVY=()
    info "TCA_SKIP_HEAVY được đặt — bỏ python và bộ biên dịch"
  fi

  # Tên gói Termux có đổi theo thời gian. Gói nào không tồn tại thì bỏ qua kèm
  # cảnh báo, chứ không làm sập cả lần cài.
  WANT=()
  for pkg in "${REQUIRED[@]}" "${TOOLS[@]}" "${HEAVY[@]}"; do
    if apt-cache show "$pkg" >/dev/null 2>&1; then
      WANT+=("$pkg")
    else
      warn "không có gói '$pkg' trong repo này, bỏ qua"
    fi
  done

  # Không tra được gói nào nghĩa là danh sách gói rỗng, chứ không phải repo thiếu
  # cả nodejs lẫn git. Đi tiếp từ đây chỉ in ra một loạt "thất bại" rồi kết thúc
  # bằng một dấu ✓ sai sự thật.
  if [ ${#WANT[@]} -eq 0 ]; then
    echo -e "\n${RED}✗ apt không tra được gói nào, kể cả nodejs.${RESET}" >&2
    cat >&2 <<'DIAG'

  Danh sách gói đang rỗng hoặc không đọc được — không phải repo thiếu nodejs.
  Gần như luôn là do `apt update` ở trên đã thất bại.

    termux-change-repo
    pkg update && pkg upgrade -y -o Dpkg::Options::=--force-confold

  Rồi chạy lại lệnh cài một dòng.

DIAG
    exit 1
  fi

  # Dung lượng lấy từ chính apt, không phải số ước lượng viết cứng trong script.
  # Số viết cứng sai ngay lần repo đổi bản, và sai theo hướng tệ nhất: bạn tin nó
  # rồi hết dung lượng giữa lúc cài.
  #
  # `--print-uris` chứ không phải `-s`: bản `-s` trên máy thật in ra "Inst …" mà
  # không in dòng "Need to get", nên nhánh nào cũng không khớp và bước này im
  # lặng hoàn toàn — đúng cái nó tồn tại để tránh. `--print-uris` in một dòng
  # mỗi file .deb kèm số byte ở cột 3, cộng lại là con số thật sẽ tải về.
  info "đang tính dung lượng cần tải…"
  bytes="$(
    apt-get install -y --print-uris "${KEEP[@]}" "${WANT[@]}" </dev/null 2>/dev/null |
      awk '{ if ($3 ~ /^[0-9]+$/) total += $3 } END { print total + 0 }'
  )"
  case "$bytes" in '' | *[!0-9]*) bytes=0 ;; esac

  # Chỗ chiếm thêm sau khi giải nén thì chỉ `-s` biết, và dòng đó có hay không
  # cũng không sao — nó chỉ là phần thêm vào câu.
  disk="$(
    apt-get install -y -s "${KEEP[@]}" "${WANT[@]}" </dev/null 2>/dev/null |
      sed -n 's/^After this operation, \(.*\) of additional disk space.*/\1/p'
  )"

  if [ "$bytes" -gt 0 ]; then
    info "cần tải: $(human_bytes "$bytes")${disk:+, chiếm thêm ${disk} bộ nhớ}"
  elif [ -n "$disk" ]; then
    info "không cần tải gì (đã có trong cache), chiếm thêm ${disk} bộ nhớ"
  else
    info "mọi gói đã có sẵn, không cần tải gì"
  fi

  # Một lệnh cho tất cả: apt giải phụ thuộc một lần và tải song song, nhanh hơn
  # hẳn so với gọi lại từng gói. Chỉ khi cả lượt fail mới xuống từng gói, để một
  # gói lỗi không kéo theo cả phần còn lại.
  info "đang cài ${#WANT[@]} gói: ${WANT[*]}"
  apt-get install -y "${KEEP[@]}" "${WANT[@]}" </dev/null 2>&1 | tail -15
  install_rc="${PIPESTATUS[0]}"
  if [ "$install_rc" -ne 0 ]; then
    warn "cài cả lượt thất bại (mã $install_rc), thử từng gói…"
    for pkg in "${WANT[@]}"; do
      apt-get install -y "${KEEP[@]}" "$pkg" </dev/null >/dev/null 2>&1 && ok "$pkg" || warn "$pkg thất bại"
    done
  fi

  # Chỉ nói xong khi thứ bắt buộc thật sự có mặt. Dòng ✓ này trước đây in vô điều
  # kiện, nên một lần cài không đặt được gói nào vẫn báo thành công — rồi để bước
  # sau báo "không có node" mà không nói vì sao.
  missing=()
  command -v node >/dev/null 2>&1 || missing+=(nodejs)
  command -v git >/dev/null 2>&1 || missing+=(git)
  if [ ${#missing[@]} -gt 0 ]; then
    echo -e "\n${RED}✗ Thiếu gói bắt buộc sau khi cài: ${missing[*]}${RESET}" >&2
    apt_broken && { repair_broken_apt || die_apt_broken; }
    echo "  Chạy tay để xem apt nói gì:  pkg install ${missing[*]}" >&2
    exit 1
  fi

  # Những gói không bắt buộc mà vẫn thiếu: nói ra ở đây, vì không còn tab nào
  # trong web UI để phát hiện chúng nữa. `tca doctor` là chỗ xem lại về sau.
  weak=()
  command -v rg >/dev/null 2>&1 || weak+=(ripgrep)
  command -v jq >/dev/null 2>&1 || weak+=(jq)
  command -v adb >/dev/null 2>&1 || weak+=(android-tools)
  [ ${#weak[@]} -eq 0 ] || warn "thiếu (agent vẫn chạy, yếu hơn): ${weak[*]} — xem thêm: tca doctor"
  ok "xong phần gói"
else
  step "Không phải Termux — bỏ qua cài gói"
  info "Hãy tự đảm bảo có node 20+ và git trên PATH."
fi

# ─── 2. Kiểm tra node ────────────────────────────────────────────────────────

step "Kiểm tra Node.js"

# Kiểm tra lệch thư viện cho từng lệnh, trước khi dùng tới nó. Nếu curl vừa bị
# hỏng kiểu này thì người dùng còn chẳng tải được script — nên vẫn báo rõ.
BROKEN=0
for bin in curl git node; do
  check_runs "$bin" || BROKEN=1
done
[ "$BROKEN" -eq 0 ] || exit 1

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

#
# Lấy source về. git nếu được, không thì tarball qua curl.
#
# Trước đây chỗ này là:
#
#   git clone ... >/dev/null 2>&1 || die "Clone thất bại. Kiểm tra mạng."
#
# và nó sai theo hai cách. Một: nó ném đi thông báo lỗi thật của git rồi thay
# bằng một phỏng đoán — và phỏng đoán đó gần như luôn sai, vì nếu mạng chết thì
# curl đã không tải nổi chính script này. Hai: nó bỏ cuộc trong khi vẫn còn một
# đường đi rõ ràng. git chỉ cần cho việc cập nhật sau này, không cần cho lần cài
# đầu tiên: GitHub có tarball, và curl thì ta biết chắc là đang chạy được.
fetch_source() {
  local repo="$1" dest="$2" out tarurl tmp

  if command -v git >/dev/null 2>&1; then
    info "đang clone $repo…"
    if out="$(git clone --depth 1 "$repo" "$dest" 2>&1 </dev/null)"; then
      ok "đã clone vào $dest"
      return 0
    fi
    warn "git clone thất bại:"
    printf '%s\n' "$out" | tail -4 | sed 's/^/      /' >&2
    # Phân loại, vì các nguyên nhân này cần những cách xử lý hoàn toàn khác nhau.
    case "$out" in
      # Trường hợp riêng, và phải xét TRƯỚC cái chung bên dưới: git chạy được,
      # `git --version` bình thường, nhưng remote helper cho https là một binary
      # khác và nó link động tới libcurl. Khi libcurl cũ hơn bản git được build
      # cho, chỉ đúng https vỡ:
      #   cannot locate symbol "curl_global_trace" referenced by git-remote-http
      # Khuyên `pkg reinstall git` ở đây là vô ích — git không phải thứ hỏng.
      *git-remote-http* | *curl_global* | *libcurl*)
        warn "không phải git hỏng, mà libcurl đang cũ hơn bản git được build cho."
        # Biết chắc cách sửa thì sửa, đừng in ra rồi bỏ mặc. Rơi xuống tarball
        # vẫn cài được, nhưng thư mục sẽ không có .git và `tca update` mất luôn —
        # một hệ quả lâu dài cho một lỗi sửa được bằng một lệnh. Đây cũng đúng
        # cách phần apt ở trên đã làm: chẩn đoán được thì tự sửa.
        if in_termux; then
          info "đang cài lại libcurl rồi thử clone lại…"
          # Clone dở dang để lại một thư mục chỉ có .git. Xoá đúng trường hợp đó,
          # chứ không xoá bất cứ thứ gì người dùng có thể đã đặt ở đây.
          if [ -d "$dest/.git" ] && [ ! -e "$dest/src/cli.js" ]; then
            rm -rf "$dest"
          fi
          if apt-get install -y --reinstall "${KEEP[@]}" libcurl </dev/null >/dev/null 2>&1 &&
            out="$(git clone --depth 1 "$repo" "$dest" 2>&1 </dev/null)"; then
            ok "đã cài lại libcurl và clone vào $dest"
            return 0
          fi
          warn "cài lại libcurl rồi vẫn không clone được:"
          printf '%s\n' "$out" | tail -3 | sed 's/^/      /' >&2
        else
          warn "  pkg install --reinstall libcurl"
        fi
        ;;
      *"CANNOT LINK EXECUTABLE"* | *"cannot locate symbol"*)
        warn "git bị lệch thư viện. Sửa: pkg upgrade -y, rồi pkg install --reinstall git" ;;
      *certificate* | *SSL* | *TLS*)
        warn "lỗi chứng chỉ. Sửa sau bằng: pkg install ca-certificates" ;;
      *"already exists"*)
        warn "$dest đã tồn tại và không rỗng. Đổi tên hoặc xoá nó rồi chạy lại." ;;
      *"could not resolve"* | *"Could not resolve"* | *"unable to access"*)
        warn "không ra được mạng từ git (curl thì được — có thể do proxy)." ;;
    esac
    info "thử tải tarball thay thế…"
  else
    info "không có git, tải tarball…"
  fi

  # github.com/user/repo.git -> .../archive/refs/heads/main.tar.gz
  tarurl="${repo%.git}"
  tarurl="${tarurl%/}/archive/refs/heads/main.tar.gz"
  tmp="${TMPDIR:-/tmp}/tca-src.$$"
  mkdir -p "$tmp" || die "không tạo được thư mục tạm"

  if ! curl -fsSL --retry 2 --connect-timeout 30 -o "$tmp/src.tar.gz" "$tarurl" </dev/null 2>"$tmp/curl.err"; then
    warn "tải tarball cũng thất bại:"
    tail -3 "$tmp/curl.err" 2>/dev/null | sed 's/^/      /' >&2
    rm -rf "$tmp"
    die "Không lấy được source. Kiểm tra mạng, rồi thử lại."
  fi
  if ! tar -xzf "$tmp/src.tar.gz" -C "$tmp" 2>/dev/null; then
    rm -rf "$tmp"
    die "Tarball tải về nhưng giải nén lỗi."
  fi

  # Tarball của GitHub bọc mọi thứ trong <repo>-<branch>/.
  local inner
  inner="$(find "$tmp" -maxdepth 2 -name cli.js -path '*/src/*' -print -quit 2>/dev/null)"
  [ -n "$inner" ] || inner="$(find "$tmp" -maxdepth 3 -name cli.js -path '*/src/*' -print -quit 2>/dev/null)"
  if [ -z "$inner" ]; then
    rm -rf "$tmp"
    die "Tarball không có src/cli.js — repo hoặc nhánh sai?"
  fi
  inner="$(dirname "$(dirname "$inner")")"

  mkdir -p "$dest" || die "không tạo được $dest"
  # cp -R chứ không mv: $dest có thể đã tồn tại và có thứ trong đó.
  cp -R "$inner"/. "$dest"/ || { rm -rf "$tmp"; die "không sao chép được source vào $dest"; }
  rm -rf "$tmp"
  ok "đã tải source vào $dest (tarball, không có git history)"
  warn "không có .git nên 'tca update' sẽ không dùng được — cài git rồi clone lại nếu cần."
}

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
    if pull_out="$(git -C "$TCA_DIR" pull --ff-only 2>&1 </dev/null)"; then
      ok "đã cập nhật"
    else
      warn "pull không xong, dùng bản đang có:"
      printf '%s\n' "$pull_out" | tail -3 | sed 's/^/      /' >&2
    fi
  elif [ -f "$TCA_DIR/src/cli.js" ]; then
    ok "đã có sẵn tại $TCA_DIR"
  else
    fetch_source "$TCA_REPO" "$TCA_DIR"
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
  git -C "$WORKSPACE" init -q </dev/null 2>/dev/null && info "đã git init (để hoàn tác được khi agent sửa sai)" || true
fi

# ─── 6. Quyền bộ nhớ ─────────────────────────────────────────────────────────

if in_termux; then
  step "Quyền bộ nhớ"
  if [ -d "$HOME/storage/shared" ]; then
    ok "đã được cấp"
  else
    info "đang xin quyền — bấm Cho phép trên hộp thoại Android"
    termux-setup-storage </dev/null >/dev/null 2>&1 || true
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
node "$TCA_DIR/src/cli.js" token </dev/null >/dev/null 2>&1 || true
ok "đã tạo config"

# ─── 9. Xong ─────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}${GREEN}  ✓ Cài đặt hoàn tất${RESET}"
echo ""
if in_termux; then
  echo -e "  ${BOLD}Gõ:${RESET}  ${BOLD}${GREEN}nhatnam${RESET}"
  echo ""
  info "Lần đầu nó sẽ hỏi có ghép nối ADB không dây không — nên trả lời có."
  info "Không có bước đó, Android giết tiến trình con của agent giữa lúc chạy."
  info "Trả lời một lần là xong: lần sau nó tự kết nối lại."
  echo ""
  info "Rồi mở đường link nó in ra trong Chrome."
else
  echo -e "  ${BOLD}Gõ:${RESET}  ${BOLD}${GREEN}tca serve${RESET}"
  echo ""
  info "rồi mở đường link nó in ra trong trình duyệt."
fi
echo ""
