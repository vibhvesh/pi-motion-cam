#!/usr/bin/env bash
# One-line installer: curl -sSL https://raw.githubusercontent.com/vibhvesh/pi-motion-cam/main/get.sh | bash
# Pass options: curl -sSL .../get.sh | bash -s -- --face
set -e
DIR="$HOME/pi-motion-cam"
command -v git >/dev/null || { sudo apt update && sudo apt install -y git; }
if [ -d "$DIR/.git" ]; then
  # keep the user's config.yaml across upgrades (upstream defaults are used for any new keys, e.g. web:)
  if ! git -C "$DIR" diff --quiet -- config.yaml; then
    cp "$DIR/config.yaml" "$DIR/config.yaml.user"; git -C "$DIR" checkout -- config.yaml
    git -C "$DIR" pull --ff-only; cp "$DIR/config.yaml" "$DIR/config.yaml.upstream"; mv "$DIR/config.yaml.user" "$DIR/config.yaml"
    echo "Kept your config.yaml (new upstream defaults saved as config.yaml.upstream)"
  else git -C "$DIR" pull --ff-only; fi
else git clone https://github.com/vibhvesh/pi-motion-cam.git "$DIR"; fi
cd "$DIR" && chmod +x install.sh && ./install.sh "$@"
