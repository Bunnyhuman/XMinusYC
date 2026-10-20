#!/bin/sh
if curl -sf -o /dev/null --max-time 1 http://127.0.0.1:8080/; then
  exit 0
fi

APP=/workspace/xminyc-app/xminyc-app
if ! curl -sf -o /dev/null --max-time 1 http://127.0.0.1:3000/; then
  cd "$APP" && nohup npm start >> /tmp/xminyc.log 2>&1 &
  i=0
  while [ "$i" -lt 50 ]; do
    curl -sf -o /dev/null --max-time 1 http://127.0.0.1:3000/ && break
    i=$((i + 1))
    sleep 0.2
  done
fi

if ! curl -sf -o /dev/null --max-time 1 http://127.0.0.1:8080/; then
  nohup node /workspace/preview-proxy.cjs >> /tmp/xminyc-proxy.log 2>&1 &
  i=0
  while [ "$i" -lt 50 ]; do
    curl -sf -o /dev/null --max-time 1 http://127.0.0.1:8080/ && break
    i=$((i + 1))
    sleep 0.2
  done
fi
exit 0
