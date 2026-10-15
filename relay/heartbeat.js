'use strict';

function pingConnections(clients, now) {
  for (const ws of clients) {
    if (ws.readyState !== 1) continue;
    const period = ws.cwHeartbeatMs || 25000;
    if (ws.cwLastPing != null && now - ws.cwLastPing < period) continue;
    try { ws.ping(); ws.cwLastPing = now; } catch {}
  }
}

module.exports = { pingConnections };
