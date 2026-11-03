#!/usr/bin/env bash
# Pi Motion Cam installer. Options (combine freely):
#   --face   face recognition for attendance (builds dlib: 30+ min)
#   --dnn    MobileNet-SSD detector (person + animals + vehicles, ~23 MB) for perimeter/animal/after-hours
#   --ocr    Tesseract OCR for number plates (apt tesseract-ocr + pytesseract)
#   --pose   MoveNet Lightning TFLite pose model (~3 MB) for better fall/fight detection
set -e
cd "$(dirname "$0")"
FACE=0; DNN=0; POSE=0; OCR=0
for a in "$@"; do case "$a" in --face) FACE=1;; --dnn) DNN=1;; --pose) POSE=1;; --ocr) OCR=1;; --all) FACE=1; DNN=1; POSE=1; OCR=1;; esac; done
sudo apt update
sudo apt install -y python3-picamera2 python3-opencv python3-numpy python3-venv python3-yaml python3-requests curl
[ $FACE = 1 ] && sudo apt install -y cmake build-essential libopenblas-dev liblapack-dev libjpeg-dev
python3 -m venv --system-site-packages venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt
[ $FACE = 1 ] && ./venv/bin/pip install face_recognition   # builds dlib, can take 30+ min
mkdir -p captures known_faces unknown_faces events summaries attendance models plates
if [ $OCR = 1 ]; then
  sudo apt install -y tesseract-ocr
  ./venv/bin/pip install pytesseract
  echo "OCR installed. Enable modules.plates in config.yaml (and detector.type: mobilenet_ssd for vehicles)"
fi
if [ $DNN = 1 ]; then
  B=https://raw.githubusercontent.com/djmv/MobilNet_SSD_opencv/master
  [ -f models/MobileNetSSD_deploy.caffemodel ] || curl -fL -o models/MobileNetSSD_deploy.caffemodel $B/MobileNetSSD_deploy.caffemodel
  [ -f models/MobileNetSSD_deploy.prototxt ] || curl -fL -o models/MobileNetSSD_deploy.prototxt $B/MobileNetSSD_deploy.prototxt
  echo "MobileNet-SSD installed. Set detector.type: mobilenet_ssd in config.yaml"
fi
if [ $POSE = 1 ]; then
  ./venv/bin/pip install ai-edge-litert || ./venv/bin/pip install tflite-runtime
  if [ ! -f models/movenet_lightning.tflite ]; then
    curl -fL https://www.kaggle.com/api/v1/models/google/movenet/tfLite/singlepose-lightning-tflite-int8/1/download | tar xz -C models
    mv models/4.tflite models/movenet_lightning.tflite 2>/dev/null || mv models/*.tflite models/movenet_lightning.tflite
  fi
  echo "MoveNet installed. Set pose.enabled: true in config.yaml"
fi
sed -e "s|__USER__|$USER|g" -e "s|__DIR__|$PWD|g" pi-motion-cam.service > pi-motion-cam.local.service
echo "Service file generated: $PWD/pi-motion-cam.local.service"
echo "  Enable autostart: sudo cp pi-motion-cam.local.service /etc/systemd/system/pi-motion-cam.service && sudo systemctl daemon-reload && sudo systemctl enable --now pi-motion-cam"
echo "Done. Enable modules in config.yaml, then run: ./venv/bin/python main.py"
