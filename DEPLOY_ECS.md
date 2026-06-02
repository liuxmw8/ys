# 国宾壹号装修预算：ECS 部署说明

推荐用 Docker 部署，避免 CentOS 7.9 上 Node.js、依赖版本和系统源的问题。

## 1. 服务器准备

在阿里云安全组开放：

- `22`：SSH
- `80`：HTTP
- `443`：HTTPS，配置证书后使用

CentOS 7.9 已经过维护期，建议后续迁移到 Alibaba Cloud Linux 3 / Rocky Linux 9 / Ubuntu 24.04。短期继续用 CentOS 7.9 时，建议只用 Docker 方式部署。

## 2. 安装 Docker

如果服务器还没有 Docker：

```bash
curl -fsSL https://get.docker.com | bash
systemctl enable docker
systemctl start docker
```

安装 Compose 插件，若系统源不可用，可以按 Docker 官方文档安装；能运行下面命令即可：

```bash
docker compose version
```

## 3. 上传项目

在服务器上创建目录：

```bash
mkdir -p /opt/renovation-budget
cd /opt/renovation-budget
```

把本仓库文件上传到这个目录。可以用 `git clone`：

```bash
git clone https://github.com/liuxmw8/ys.git .
```

或用 `scp` 上传本地文件。

## 4. 设置访问密码

创建 `.env`：

```bash
cat > .env <<'EOF'
APP_PASSWORD=换成你的强密码
EOF
```

设置后访问网页会弹出浏览器自带登录框。用户名随便填，密码填这里的 `APP_PASSWORD`。

## 5. 启动

```bash
docker compose up -d --build
```

检查：

```bash
docker logs -f renovation-budget
curl http://127.0.0.1:3000/api/health
```

访问：

```text
http://服务器公网IP:3000
```

如果只想通过 Nginx 暴露域名，可以在阿里云安全组里不要开放 `3000`，只开放 `80/443`。

## 6. Nginx 反向代理

安装 Nginx 后，把 `deploy/nginx-renovation-budget.conf` 复制到：

```bash
/etc/nginx/conf.d/renovation-budget.conf
```

修改里面的：

```nginx
server_name your-domain.example.com;
```

然后：

```bash
nginx -t
systemctl reload nginx
```

## 7. HTTPS

如果域名已经解析到 ECS，可以用 certbot 或阿里云证书配置 HTTPS。配置 HTTPS 后，建议只通过 `https://你的域名/` 使用。

## 8. 数据位置和备份

服务器数据都在：

```text
/opt/renovation-budget/runtime/
├─ budget-data.json
└─ uploads/
```

备份：

```bash
tar czf renovation-budget-backup-$(date +%F).tgz runtime
```

恢复时停掉容器，解压覆盖 `runtime`，再启动：

```bash
docker compose down
tar xzf renovation-budget-backup-YYYY-MM-DD.tgz
docker compose up -d
```

## 9. 从 Gist 迁移旧数据

部署后第一次打开服务器版网页：

1. 进入“同步设置”
2. 填入旧的 `Gist ID` 和 GitHub token
3. 点击“从 Gist 读取”

网页读取成功后会自动保存到服务器的 `runtime/budget-data.json`。之后就可以主要使用服务器数据，不再依赖 Gist。

## 10. 更新部署

```bash
cd /opt/renovation-budget
git pull
docker compose up -d --build
```

`runtime/` 是挂载目录，不会被镜像重建覆盖。

## 11. 后端接口

- `GET /api/data`：读取预算数据
- `PUT /api/data`：保存预算数据
- `POST /api/upload`：上传图片，字段名 `image`
- `POST /api/fetch-product`：尝试解析商品链接或分享文案

淘宝、京东纯链接可能因为反爬、登录、动态渲染等原因无法稳定解析。分享文案通常更可靠。
