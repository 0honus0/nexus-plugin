set -eu
install -d -m 0755 /var/run/xrdp
/usr/sbin/xrdp-sesman --nodaemon &
/usr/sbin/xrdp --nodaemon &
runuser -u desktop -- Xtigervnc :7 -geometry 960x640 -SecurityTypes None -localhost no -rfbport 5907 &
for attempt in $(seq 1 50); do
    if runuser -u desktop -- env DISPLAY=:7 xset q >/dev/null 2>&1; then
        runuser -u desktop -- env DISPLAY=:7 xterm -title Nexus-VNC-fixture &
        wait
        exit
    fi
    sleep 0.1
done
exit 1
