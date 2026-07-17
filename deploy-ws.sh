#!/usr/bin/env bash
# Мгновенная выкатка прототипа на https://ws.meriler.cc/ (Aeza, nginx, /var/www/ws).
# HTML отдаётся с Cache-Control: no-store → правки видны сразу после F5, без CDN/Actions.
# Использование: ./deploy-ws.sh   (с Mac mini, ssh-алиас aeza уже настроен)
set -e
cd "$(dirname "$0")"
rsync -az --exclude='.git' --exclude='.DS_Store' --exclude='_v1*' \
  --exclude='node_modules' --exclude='*.test.mjs' \
  vendor models assets app content z1.html v2.html v3.html v4.html v5.html slides.html nav-proto.html index.html aeza:/var/www/ws/
echo "✅ выкачено на https://ws.meriler.cc/  ($(date +%H:%M:%S))"
echo "   v4 (честный замер; воркшоп ?ws=1): https://ws.meriler.cc/v4.html"
echo "   v3 (image-KNN, fallback):          https://ws.meriler.cc/v3.html"
echo "   v2 (рабочая простая):              https://ws.meriler.cc/v2.html"
