FROM debian:bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    xrdp xorgxrdp tigervnc-standalone-server xterm xauth x11-xserver-utils dbus-x11 \
    && rm -r /var/lib/apt/lists
RUN useradd -m -s /bin/bash desktop \
    && echo 'desktop:nexus-local-fixture' | chpasswd \
    && printf '#!/bin/sh\nexec xterm -title Nexus-RDP-fixture\n' >/home/desktop/.xsession \
    && chown desktop:desktop /home/desktop/.xsession \
    && chmod 755 /home/desktop/.xsession
COPY start.sh /start.sh
CMD ["sh", "/start.sh"]
