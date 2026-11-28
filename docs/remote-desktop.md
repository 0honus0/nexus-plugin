# Nexus Remote Desktop

Use the Remote Desktop application to open saved RDP and VNC connections. Connection Management and Workspace can launch it when the plugin is enabled.

- **Native** uses IronRDP WASM for RDP and noVNC for VNC. The Nexus server forwards the protocol to the browser. The browser receives credentials for that session over the signed-in Nexus connection. Use HTTPS for deployed instances.
- **Guacamole gateway** uses guacd 1.6.0 or newer. guacd/FreeRDP handles RDP on the server and sends Guacamole display updates to the browser. The browser receives a short-lived ticket. Passwords are passed server-side to guacd.

Set `NEXUS_GUACD_HOST` on the Nexus server to show the gateway option. `NEXUS_GUACD_PORT` defaults to `4822`. Run guacd on a private network reachable from Nexus. Keep the guacd port private because its TCP listener does not authenticate clients. Both Nexus and guacd need to reach RDP targets because Nexus separately checks the endpoint certificate before establishing the session.

For RDP, the certificate prompt lets you trust a fingerprint once or save it for that host and port on the current Nexus installation. A changed fingerprint requires confirmation again. Opening an RDP or VNC connection from Workspace or Connections starts the session immediately and prompts for certificate verification when needed.

RDP uses a saved password credential. VNC can use either a saved password credential or no credential when the server allows it. Modes and resolutions are selected in the window, with no schema migration. Without a configured gateway, the plugin offers Native. The session toolbar supports fullscreen and can be pinned in windowed mode. Native RDP supports text and file clipboard operations when the remote server supports them. Native RDP currently leaves audio redirection disabled because the pinned SDK can reject the RDPDR login sequence sent by xrdp.

On a touchscreen, tap the remote display to click, hold to right-click, and swipe with two fingers to scroll. Use the Keyboard button in the session toolbar to open or dismiss the device keyboard.

For comparing WAN performance, open the same target at the same resolution in both modes. Compare a static screen, scrolling and dragging a window. Hold the gateway location, browser and target constant when attributing differences to the decoding path.

## Tests

From the plugin repository root, run the packaged browser and service tests with `pnpm test:plugin remote-desktop`. Docker and Playwright Chromium are required. To include live xrdp, TigerVNC, and guacd sessions, run:

```sh
docker build -t nexus-desktop-test:fixtures plugins/remote-desktop/tests/fixtures
NEXUS_TEST_REAL_DESKTOP=1 pnpm test:plugin remote-desktop
```

The live suite exercises both desktop and emulated phone sessions. It uses a temporary Docker network for the targets and removes it with the containers after the run.
