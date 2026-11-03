#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
sudo apt update
sudo apt install -y python3-picamera2 python3-opencv python3-numpy python3-venv python3-yaml python3-requests
if [ "$1" = "--face" ]; then
  sudo apt install -y cmake build-essential libopenblas-dev liblapack-dev libjpeg-dev
fi
python3 -m venv --system-site-packages venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt
if [ "$1" = "--face" ]; then
  ./venv/bin/pip install face_recognition   # builds dlib, can take 30+ min
fi
mkdir -p captures known_faces
sed -e "s|__USER__|$USER|g" -e "s|__DIR__|$PWD|g" pi-motion-cam.service > pi-motion-cam.local.service
echo "Service file generated: $PWD/pi-motion-cam.local.service"
echo "  Enable autostart: sudo cp pi-motion-cam.local.service /etc/systemd/system/pi-motion-cam.service && sudo systemctl daemon-reload && sudo systemctl enable --now pi-motion-cam"
echo "Done. Edit config.yaml, then run: ./venv/bin/python main.py"
