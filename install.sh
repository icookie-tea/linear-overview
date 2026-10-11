#!/usr/bin/env bash
#
# Install / uninstall this GNOME Shell extension for the current user.
#
#   ./install.sh              copy the extension into the user's extensions dir
#   ./install.sh --dev        symlink this repository instead of copying it
#   ./install.sh --uninstall  remove the installed extension
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

UUID="$(sed -n 's/^[[:space:]]*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' metadata.json | head -n 1)"
EXTENSIONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
TARGET_DIR="$EXTENSIONS_DIR/$UUID"

mode="copy"      # copy | link
action="install" # install | uninstall

usage() {
    cat <<EOF
用法: ./install.sh [选项]

  --dev         以符号链接方式安装（改代码后重载扩展即可，方便开发）
  --copy        复制文件安装（默认）
  --uninstall   卸载已安装的扩展
  -h, --help    显示本帮助

扩展 UUID: ${UUID:-未知}
安装目录:  $TARGET_DIR
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dev) mode="link" ;;
        --copy) mode="copy" ;;
        --uninstall) action="uninstall" ;;
        -h|--help) usage; exit 0 ;;
        *) echo "未知选项: $1" >&2; usage; exit 1 ;;
    esac
    shift
done

if [ ! -f metadata.json ]; then
    echo "错误: 请在扩展目录里运行此脚本（找不到 metadata.json）" >&2
    exit 1
fi

if [ -z "$UUID" ]; then
    echo "错误: 无法从 metadata.json 读取 uuid" >&2
    exit 1
fi

install_extension() {
    rm -rf "$TARGET_DIR"
    mkdir -p "$TARGET_DIR"

    if [ "$mode" = "link" ]; then
        # symlink the whole repository, so extension.js and lib/ stay live
        rm -rf "$TARGET_DIR"
        ln -s "$SCRIPT_DIR" "$TARGET_DIR"
        echo "已链接: $TARGET_DIR -> $SCRIPT_DIR"
    else
        cp extension.js metadata.json dev-config.json "$TARGET_DIR/"
        cp -r lib "$TARGET_DIR/lib"
        echo "已安装: $TARGET_DIR"
    fi

    if command -v gnome-extensions >/dev/null; then
        gnome-extensions enable "$UUID" 2>/dev/null || \
            echo "提示: 请注销并重新登录，然后在扩展应用中启用 ${UUID}"
    fi
}

uninstall_extension() {
    if command -v gnome-extensions >/dev/null; then
        gnome-extensions disable "$UUID" 2>/dev/null || true
    fi

    rm -rf "$TARGET_DIR"
    echo "已卸载: $TARGET_DIR"
}

case "$action" in
    install) install_extension ;;
    uninstall) uninstall_extension ;;
esac
