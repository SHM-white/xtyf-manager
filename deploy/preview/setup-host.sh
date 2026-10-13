#!/usr/bin/env bash
# 在承载预览的 Linux 服务器（推荐现有云服务器，不是生产树莓派）上由管理员运行一次。
set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || { echo "请用 sudo 运行"; exit 1; }
DOMAIN="${1:-}"
DEPLOY_USER="${2:-preview-deploy}"
[[ "$DOMAIN" =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ ]] || { echo "参数1：预览域名后缀，如 preview.example.com"; exit 1; }
[[ "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo "部署用户名不合法"; exit 1; }
id "$DEPLOY_USER" >/dev/null 2>&1 || { echo "请先创建部署用户：$DEPLOY_USER"; exit 1; }
for cmd in docker openssl visudo; do
  command -v "$cmd" >/dev/null || { echo "缺少命令：$cmd"; exit 1; }
done

CONFIG=/etc/xtyf-preview
install -d -m 0750 "$CONFIG"
install -d -m 0755 "$CONFIG/conf.d"
if [[ ! -s "$CONFIG/.htpasswd" ]]; then
  echo "缺少 $CONFIG/.htpasswd。请先执行："
  echo "  sudo apt-get install -y apache2-utils"
  echo "  sudo htpasswd -cB $CONFIG/.htpasswd preview"
  exit 1
fi

printf 'PREVIEW_BASE_DOMAIN=%s\n' "$DOMAIN" > "$CONFIG/config"
chmod 0600 "$CONFIG/config"
if [[ ! -e "$CONFIG/app.env" ]]; then
  umask 077
  printf 'PROGRESS_INITIAL_ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 24)" > "$CONFIG/app.env"
fi
chmod 0600 "$CONFIG/app.env" "$CONFIG/.htpasswd"
# 安装可信文件：Actions 只调用该固定程序，不从 PR 中覆盖运行控制脚本。
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
install -m 0644 "$SOURCE_DIR/Dockerfile" "$CONFIG/Dockerfile"
install -m 0755 "$SOURCE_DIR/previewctl" /usr/local/bin/xtyf-previewctl
cat > "$CONFIG/conf.d/00-default.conf" <<'CONF'
server {
    listen 80 default_server;
    server_name _;
    return 404;
}
CONF

docker network inspect xtyf-preview-net >/dev/null 2>&1 || docker network create xtyf-preview-net
if ! docker container inspect xtyf-preview-gateway >/dev/null 2>&1; then
  docker run -d --name xtyf-preview-gateway --restart unless-stopped \
    --network xtyf-preview-net -p 127.0.0.1:8081:80 \
    -v "$CONFIG/conf.d:/etc/nginx/conf.d:ro" \
    -v "$CONFIG/.htpasswd:/etc/nginx/.htpasswd:ro" \
    nginx:stable-alpine >/dev/null
else
  docker start xtyf-preview-gateway >/dev/null 2>&1 || true
fi
docker exec xtyf-preview-gateway nginx -t
docker exec xtyf-preview-gateway nginx -s reload

# sudoers 的通配符调用只允许受信任的固定脚本；不要授权整个 docker CLI。
printf '%s ALL=(root) NOPASSWD: /usr/local/bin/xtyf-previewctl\n' "$DEPLOY_USER" \
  > "/etc/sudoers.d/xtyf-preview-$DEPLOY_USER"
chmod 0440 "/etc/sudoers.d/xtyf-preview-$DEPLOY_USER"
visudo -cf "/etc/sudoers.d/xtyf-preview-$DEPLOY_USER"
echo "预览网关就绪：127.0.0.1:8081（仅本机监听，需另配 Nginx/DNS）"
echo "业务测试账号：admin；密码存放在 $CONFIG/app.env（不要提交 Git 或贴到 PR）。"
