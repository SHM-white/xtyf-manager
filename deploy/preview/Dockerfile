# 安装在预览服务器上的可信 Dockerfile；PR 自身的 Dockerfile 修改不会控制构建命令。
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app \
    MPLCONFIGDIR=/tmp/matplotlib \
    XDG_CACHE_HOME=/tmp/cache
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /app/requirements.txt
RUN python -m pip install --no-cache-dir -r /app/requirements.txt gunicorn
COPY . /app

RUN groupadd --gid 10001 preview && useradd --uid 10001 --gid 10001 --no-create-home preview \
    && mkdir -p /var/lib/xtyf-preview \
    && chown -R 10001:10001 /var/lib/xtyf-preview
USER 10001:10001
EXPOSE 8520
CMD ["sh", "-c", "python deploy/preview/seed_demo.py && exec gunicorn --workers 1 --threads 8 --timeout 120 --bind 0.0.0.0:8520 --access-logfile - app:app"]
