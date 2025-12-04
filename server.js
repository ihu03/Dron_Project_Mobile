const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const webPush = require("web-push");

const PORT = process.env.PORT || 8000;
const REMOTE = "https://seoul.flightfeeder.page/data/aircraft.json";
const PLANESPOTTERS_API = "https://api.planespotters.net/pub/photos/hex/";
const PLACEHOLDER_IMG_PAT = /(placeholder|no[-_ ]?photo|missing|default)/i;
const SUBS_FILE = path.join(process.cwd(), "subscriptions.json");
const VAPID_FILE = path.join(process.cwd(), "vapid-keys.json");
const VAPID_CONTACT = process.env.VAPID_CONTACT || "mailto:adsb@example.com";
const MAX_BODY_BYTES = 50 * 1024;
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

function readJsonSafe(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function writeJsonSafe(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.warn("writeJsonSafe failed", e);
    return false;
  }
}

function loadSubscriptions() {
  const list = readJsonSafe(SUBS_FILE, []);
  return Array.isArray(list) ? list : [];
}

function saveSubscriptions(list) {
  return writeJsonSafe(SUBS_FILE, Array.isArray(list) ? list : []);
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function handlePreflight(req, res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end();
}

const vapidKeys = readJsonSafe(VAPID_FILE, null);
const vapidReady = Boolean(vapidKeys?.publicKey && vapidKeys?.privateKey);
if (vapidReady) {
  webPush.setVapidDetails(VAPID_CONTACT, vapidKeys.publicKey, vapidKeys.privateKey);
} else {
  console.warn("[push] VAPID 키를 찾을 수 없어 푸시 전송이 비활성화됩니다.");
}

const serveFile = (filePath, res) => {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === "ENOENT" ? 404 : 500);
      res.end();
      return;
    }
    const type = mime[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Access-Control-Allow-Origin": "*",
    });
    res.end(data);
  });
};

function sendPlaceholder(res, hex = "") {
  const safeHex = String(hex || "").toUpperCase().slice(0, 8) || "N/A";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="260" viewBox="0 0 600 260" role="img" aria-label="기체 이미지를 불러올 수 없음"><rect width="600" height="260" fill="#0b1224"/><rect x="18" y="18" width="564" height="224" rx="18" fill="#0f172a" stroke="#1f2946"/><text x="40" y="120" fill="#e5edf9" font-family="Segoe UI, Arial, sans-serif" font-size="28" font-weight="700">기체 이미지를 불러올 수 없음</text><text x="40" y="170" fill="#8ca0c3" font-family="Segoe UI, Arial, sans-serif" font-size="20" font-weight="600">HEX: ${safeHex}</text></svg>`;
  res.writeHead(200, {
    "Content-Type": "image/svg+xml",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(svg);
}

function fetchPlanespottersImage(hex, res) {
  const apiUrl = `${PLANESPOTTERS_API}${hex}`;
  const apiReq = https.request(
    apiUrl,
    {
      method: "GET",
      headers: {
        "User-Agent": "adsb-viewer/1.0",
        Accept: "application/json",
      },
    },
    (apiRes) => {
      if (apiRes.statusCode !== 200) {
        return sendPlaceholder(res, hex);
      }
      let body = "";
      apiRes.on("data", (chunk) => (body += chunk));
      apiRes.on("end", () => {
        try {
          const data = JSON.parse(body);
          const photo = Array.isArray(data?.photos) ? data.photos[0] : null;
          const imgUrl =
            photo?.thumbnail_large?.src ||
            photo?.thumbnail?.src ||
            photo?.thumbnail_large ||
            photo?.thumbnail ||
            photo?.link;
          if (!imgUrl || PLACEHOLDER_IMG_PAT.test(String(imgUrl))) return sendPlaceholder(res, hex);
          if (!imgUrl) return sendPlaceholder(res, hex);
          https
            .get(imgUrl, (imgRes) => {
              if (imgRes.statusCode !== 200) return sendPlaceholder(res, hex);
              const contentType = imgRes.headers["content-type"] || "image/jpeg";
              const contentLength = Number(imgRes.headers["content-length"] || 0);
              if (/svg/i.test(contentType) || (contentLength && contentLength < 5000)) {
                return sendPlaceholder(res, hex);
              }
              const writeHead = () => {
                res.writeHead(200, {
                  "Content-Type": contentType,
                  "Cache-Control": "max-age=300",
                  "Access-Control-Allow-Origin": "*",
                });
              };
              // Sniff first chunk for inline SVG placeholder that slips past headers
              let headChecked = false;
              imgRes.on("data", (chunk) => {
                if (!headChecked) {
                  headChecked = true;
                  const headText = chunk.slice(0, 1024).toString("utf8");
                  if (headText.includes("<svg")) {
                    imgRes.destroy();
                    return sendPlaceholder(res, hex);
                  }
                  writeHead();
                  res.write(chunk);
                } else {
                  res.write(chunk);
                }
              });
              imgRes.on("end", () => {
                res.end();
              });
              imgRes.on("error", () => sendPlaceholder(res, hex));
            })
            .on("error", () => sendPlaceholder(res, hex));
        } catch (e) {
          sendPlaceholder(res, hex);
        }
      });
    }
  );
  apiReq.on("timeout", () => {
    apiReq.destroy();
    sendPlaceholder(res, hex);
  });
  apiReq.on("error", () => sendPlaceholder(res, hex));
  apiReq.setTimeout(5000);
  apiReq.end();
}

async function handleSubscription(req, res) {
  if (req.method === "OPTIONS") {
    handlePreflight(req, res);
    return true;
  }
  if (req.method !== "POST") return false;
  try {
    const body = await parseJsonBody(req);
    const subscription = body?.subscription || body;
    if (!subscription?.endpoint) {
      sendJson(res, 400, { error: "invalid subscription" });
      return true;
    }
    const list = loadSubscriptions();
    const idx = list.findIndex((s) => s.endpoint === subscription.endpoint);
    if (idx >= 0) list[idx] = subscription;
    else list.push(subscription);
    saveSubscriptions(list);
    sendJson(res, 201, { ok: true, total: list.length });
  } catch (e) {
    sendJson(res, 400, { error: "invalid json" });
  }
  return true;
}

async function handlePushTest(req, res) {
  if (req.method === "OPTIONS") {
    handlePreflight(req, res);
    return true;
  }
  if (req.method !== "POST") return false;
  if (!vapidReady) {
    sendJson(res, 503, { error: "vapid_not_configured" });
    return true;
  }
  const subs = loadSubscriptions();
  if (!subs.length) {
    sendJson(res, 200, { ok: true, sent: 0, failed: 0, removed: 0, message: "no subscriptions" });
    return true;
  }

  let payloadBody = {};
  try {
    payloadBody = await parseJsonBody(req);
  } catch (e) {
    payloadBody = {};
  }
  const notification = {
    title: payloadBody.title || "ADS-B 알림",
    body: payloadBody.body || "테스트 알림입니다.",
    icon: payloadBody.icon || "/icons/icon-192.png",
    badge: payloadBody.badge || "/icons/icon-192.png",
    data: { url: payloadBody.url || payloadBody?.data?.url || "/", ...payloadBody.data },
  };
  const payload = JSON.stringify(notification);

  const results = await Promise.all(
    subs.map((sub) =>
      webPush
        .sendNotification(sub, payload)
        .then(() => ({ ok: true }))
        .catch((err) => ({ ok: false, status: err?.statusCode, endpoint: sub?.endpoint }))
    )
  );

  const toRemove = new Set();
  results.forEach((r, idx) => {
    if (!r.ok && (r.status === 404 || r.status === 410)) toRemove.add(idx);
  });
  if (toRemove.size) {
    const filtered = subs.filter((_, idx) => !toRemove.has(idx));
    saveSubscriptions(filtered);
  }

  const sent = results.filter((r) => r.ok).length;
  sendJson(res, 200, { ok: true, sent, failed: results.length - sent, removed: toRemove.size });
  return true;
}

async function handlePushSafety(req, res) {
  if (req.method === "OPTIONS") {
    handlePreflight(req, res);
    return true;
  }
  if (req.method !== "POST") return false;
  if (!vapidReady) {
    sendJson(res, 503, { error: "vapid_not_configured" });
    return true;
  }
  const subs = loadSubscriptions();
  if (!subs.length) {
    sendJson(res, 200, { ok: true, sent: 0, failed: 0, removed: 0, message: "no subscriptions" });
    return true;
  }

  let payloadBody = {};
  try {
    payloadBody = await parseJsonBody(req);
  } catch (e) {
    payloadBody = {};
  }
  const entries = Array.isArray(payloadBody.entries) ? payloadBody.entries : [];
  const title = `안전반경 침입: ${entries.length || ""}대`;
  const body =
    entries
      .slice(0, 5)
      .map((e) => `${e.call || e.hex || "unknown"} (${Number(e.dist || 0).toFixed(1)}km)`)
      .join(", ") || "새 기체가 안전반경에 들어왔습니다.";
  const notification = {
    title,
    body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: "/" },
  };
  const payload = JSON.stringify(notification);

  const results = await Promise.all(
    subs.map((sub) =>
      webPush
        .sendNotification(sub, payload)
        .then(() => ({ ok: true }))
        .catch((err) => ({ ok: false, status: err?.statusCode, endpoint: sub?.endpoint }))
    )
  );

  const toRemove = new Set();
  results.forEach((r, idx) => {
    if (!r.ok && (r.status === 404 || r.status === 410)) toRemove.add(idx);
  });
  if (toRemove.size) {
    const filtered = subs.filter((_, idx) => !toRemove.has(idx));
    saveSubscriptions(filtered);
  }

  const sent = results.filter((r) => r.ok).length;
  sendJson(res, 200, { ok: true, sent, failed: results.length - sent, removed: toRemove.size });
  return true;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    handlePreflight(req, res);
    return;
  }

  if (req.url.startsWith("/api/aircraft")) {
    https.get(REMOTE, (r) => {
      let body = "";
      r.on("data", (chunk) => (body += chunk));
      r.on("end", () => {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(body);
      });
    }).on("error", () => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "upstream" }));
    });
    return;
  }

  if (req.url.startsWith("/api/plane-image")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const hex = (url.searchParams.get("hex") || "").replace(/[^0-9a-fA-F]/g, "").slice(0, 6);
    if (!hex) {
      sendPlaceholder(res);
      return;
    }
    fetchPlanespottersImage(hex.toLowerCase(), res);
    return;
  }

  if (req.url.startsWith("/vapid-public-key")) {
    if (!vapidReady) {
      sendJson(res, 503, { error: "vapid_not_configured" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(vapidKeys.publicKey);
    return;
  }

  if (req.url.startsWith("/api/subscriptions")) {
    const handled = await handleSubscription(req, res);
    if (handled) return;
  }

  if (req.url.startsWith("/api/push/test")) {
    const handled = await handlePushTest(req, res);
    if (handled) return;
  }

  if (req.url.startsWith("/api/push/safety")) {
    const handled = await handlePushSafety(req, res);
    if (handled) return;
  }

  const safePath = path.normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^\/+/, "");
  const filePath = path.join(process.cwd(), safePath || "index.html");
  fs.stat(filePath, (err, stats) => {
    if (!err && stats.isDirectory()) {
      serveFile(path.join(filePath, "index.html"), res);
    } else {
      serveFile(filePath, res);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
