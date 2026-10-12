ARG MAGPIE_IMAGE=ghcr.io/yetone/magpie:latest
FROM ${MAGPIE_IMAGE} AS magpie-binary

FROM mcr.microsoft.com/playwright:v1.64.0-noble AS browser

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11vnc novnc websockify fluxbox supervisor curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json npm-shrinkwrap.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY dist ./dist
COPY docker /app/docker
RUN cp /app/docker/supervisord.conf /app/docker/desktop.conf
RUN chmod 755 /app/docker/entrypoint.sh \
    && mkdir -p /data/profiles /run/secrets \
    && chown -R pwuser:pwuser /app /data

USER pwuser
ENV DISPLAY=:99
EXPOSE 6080
ENTRYPOINT ["/app/docker/entrypoint.sh"]

FROM browser AS gateway
USER root
COPY --from=magpie-binary /magpie /usr/local/bin/magpie
COPY docker/gateway.conf /app/docker/supervisord.conf
RUN mkdir -p /data/magpie /data/cache /data/state /data/home \
    && chown -R pwuser:pwuser /data
USER pwuser
ENV HOME=/data/home \
    XDG_CONFIG_HOME=/data/magpie \
    XDG_CACHE_HOME=/data/cache \
    XDG_DATA_HOME=/data \
    XDG_STATE_HOME=/data/state \
    MAGPIE_ADDR=0.0.0.0:3425
EXPOSE 3425 3430
