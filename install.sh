#!/usr/bin/env bash
# Pi Motion Cam installer. Options (combine freely):
#   --face   face recognition for attendance (builds dlib: 30+ min)
#   --dnn    MobileNet-SSD detector (person + animals + vehicles, ~23 MB) for perimeter/animal/after-hours
#   --ocr    Tesseract OCR for number plates (apt tesseract-ocr + pytesseract)
#   --alpr   optional ONNX plate detector + fast-plate-ocr (pip onnxruntime open-image-models fast-plate-ocr, ~15 MB models)
#   --no-service  don't install/enable the systemd services (camera + web dashboard)
#   --pose   MoveNet Lightning TFLite pose model (~3 MB) for better fall/fight detection
set -e
cd "$(dirname "$0")"
FACE=0; DNN=0; POSE=0; OCR=0; ALPR=0; SVC=1
for a in "$@"; do case "$a" in --face) FACE=1;; --dnn) DNN=1;; --pose) POSE=1;; --ocr) OCR=1;; --alpr) ALPR=1;; --no-service) SVC=0;; --all) FACE=1; DNN=1; POSE=1; OCR=1;; esac; done
sudo apt update
sudo apt install -y python3-picamera2 python3-opencv python3-numpy python3-venv python3-yaml python3-requests python3-flask curl
[ $FACE = 1 ] && sudo apt install -y cmake build-essential libopenblas-dev liblapack-dev libjpeg-dev
python3 -m venv --system-site-packages venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt
[ $FACE = 1 ] && ./venv/bin/pip install face_recognition   # builds dlib, can take 30+ min
mkdir -p captures known_faces unknown_faces events summaries attendance models plates
if [ $ALPR = 1 ]; then
  ./venv/bin/pip install onnxruntime open-image-models fast-plate-ocr
  ./venv/bin/python -c "from open_image_models import LicensePlateDetector as D; from fast_plate_ocr import LicensePlateRecognizer as R; D(detection_model='yolo-v9-t-384-license-plate-end2end'); R('cct-xs-v1-global-model')" \
    && echo "ALPR models ready. Set modules.plates.plate_detector: onnx and/or ocr_engine: fast_plate_ocr"
fi
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
sed -e "s|__USER__|$USER|g" -e "s|__DIR__|$PWD|g" pi-motion-cam-web.service > pi-motion-cam-web.local.service
if [ $SVC = 1 ]; then
  sudo cp pi-motion-cam.local.service /etc/systemd/system/pi-motion-cam.service
  sudo cp pi-motion-cam-web.local.service /etc/systemd/system/pi-motion-cam-web.service
  # let the dashboard (runs as $USER) start/stop/restart the camera service and read its logs, nothing else
  SC=$(command -v systemctl); JC=$(command -v journalctl)
  printf '%s ALL=(root) NOPASSWD: %s start pi-motion-cam, %s stop pi-motion-cam, %s restart pi-motion-cam, %s -u pi-motion-cam *\n' "$USER" "$SC" "$SC" "$SC" "$JC" | sudo tee /etc/sudoers.d/pi-motion-cam >/dev/null
  sudo chmod 440 /etc/sudoers.d/pi-motion-cam
  sudo visudo -cf /etc/sudoers.d/pi-motion-cam >/dev/null || sudo rm -f /etc/sudoers.d/pi-motion-cam
  sudo systemctl daemon-reload
  sudo systemctl enable pi-motion-cam pi-motion-cam-web
  sudo systemctl restart pi-motion-cam-web
  sudo systemctl restart pi-motion-cam || true
else
  echo "Services not installed (--no-service). Run manually: ./venv/bin/python main.py  and  ./venv/bin/python -m webui.server"
fi
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
PORT=$(./venv/bin/python -c "import yaml;print((yaml.safe_load(open('config.yaml')).get('web') or {}).get('port',8080))" 2>/dev/null || echo 8080)
echo
echo "============================================================"
echo " Done. Dashboard: http://${IP:-<pi-ip>}:${PORT}   (also http://$(hostname).local:${PORT})"
echo " Open it on a phone/PC on the same Wi-Fi to enable modules, label faces, view events."
echo " Logs: journalctl -u pi-motion-cam -f   |   sudo systemctl restart pi-motion-cam"
echo "============================================================"
