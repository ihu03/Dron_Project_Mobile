const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8000;
const REMOTE = "https://seoul.flightfeeder.page/data/aircraft.json";
const PLANESPOTTERS_API = "https://api.planespotters.net/pub/photos/hex/";
const PLACEHOLDER_IMG_PAT = /(placeholder|no[-_ ]?photo|missing|default)/i;
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

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

const server = http.createServer((req, res) => {
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
