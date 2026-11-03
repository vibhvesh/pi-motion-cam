#!/usr/bin/env bash
# One-line installer: curl -sSL https://raw.githubusercontent.com/vibhvesh/pi-motion-cam/main/get.sh | bash
# Pass options: curl -sSL .../get.sh | bash -s -- --face
set -e
DIR="$HOME/pi-motion-cam"
command -v git >/dev/null || { sudo apt update && sudo apt install -y git; }
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone https://github.com/vibhvesh/pi-motion-cam.git "$DIR"; fi
cd "$DIR" && chmod +x install.sh && ./install.sh "$@"
