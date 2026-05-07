ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-bookworm

ARG BUN_VERSION=1.3.13

ENV BUN_INSTALL=/usr/local/bun
ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="${BUN_INSTALL}/bin:${PATH}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    dbus-x11 \
    fd-find \
    git \
    git-lfs \
    gnupg \
    jq \
    less \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libgtk-4-1 \
    libnss3 \
    libsecret-1-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxkbcommon0 \
    libxrandr2 \
    libxshmfence1 \
    libxss1 \
    lsof \
    openssh-client \
    pkg-config \
    procps \
    python3 \
    python3-pip \
    python3-setuptools \
    ripgrep \
    rsync \
    shellcheck \
    shfmt \
    sudo \
    tree \
    unzip \
    xdg-utils \
    xvfb \
    zsh \
    zip \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
  && ln -sf "${BUN_INSTALL}/bin/bun" /usr/local/bin/bun \
  && ln -sf "${BUN_INSTALL}/bin/bunx" /usr/local/bin/bunx \
  && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
  && npm install -g node-gyp \
  && usermod -aG sudo node \
  && echo "node ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/node \
  && chmod 0440 /etc/sudoers.d/node \
  && git lfs install --system
