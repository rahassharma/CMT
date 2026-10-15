FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Data directory: mount a volume here (DATA_DIR) so the database and uploaded
# PDFs survive redeploys. /data is a plain directory by default so the image
# also runs fine without a volume.
ENV DATA_DIR=/data
RUN mkdir -p /data/uploads && \
    adduser --disabled-password --gecos "" cmt && \
    chown -R cmt:cmt /app /data
USER cmt

EXPOSE 8000

# Render/Fly/Railway set $PORT automatically; 8000 is the local default.
CMD ["sh", "-c", "gunicorn app:app --bind 0.0.0.0:${PORT:-8000} --workers 2 --threads 4 --timeout 60 --access-logfile - --error-logfile -"]
