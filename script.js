// CORS를 피하기 위해 로컬 프록시(server.js)로 우회
const DATA_URL = "/api/aircraft";
const DEFAULT_POLL_MS = 1000;
let pollMs = DEFAULT_POLL_MS;
const STALE_MS = 45000;
const MAX_TRAIL_POINTS = 300;
const FT_TO_M = 0.3048;
let altitudeToleranceMinM = 0;
let altitudeToleranceMaxM = 6000; // 최대 6km 기본
let radarRadiusKm = 30;
let safetyRadiusKm = 5;
let suppressAutoSelect = false;
const APPROACH_KM_PER_MIN = 12; // 분당 접근 거리(km) 기준 속도(약 720km/h)
const MAP_BRIGHTNESS_DEFAULT = 70;

// Leaflet 지도 초기화
const map = L.map("map", { worldCopyJump: true }).setView([37.5665, 126.9780], 8);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: "(c) OpenStreetMap contributors",
}).addTo(map);

// 기체 상태 캐시 (마커/궤적/색상/반경)
const markers = new Map(); // hex -> { marker, lastSeen }
const trails = new Map(); // hex -> LatLng[]
const trailLines = new Map(); // hex -> polyline
const colors = new Map(); // hex -> color
const fakeOverlays = new Map(); // hex -> { radar, safety }
const sectorOverlays = new Map(); // hex -> L.Layer[] (clear sectors)
let selectedHex = null;
let latestAircraft = [];
let fakePlanes = [];
let lastSafetyHexes = new Set();

// DOM 캐싱
const tableBody = document.getElementById("table-body");
const searchInput = document.getElementById("search");
const clearFilter = document.getElementById("clearFilter");
const statsEl = document.getElementById("stats");
const pingEl = document.getElementById("ping");
const radarCountEl = document.getElementById("radar-count");
const warnEl = document.getElementById("warn-msg");
const radarRadiusInput = document.getElementById("radar-radius-input");
const safetyRadiusInput = document.getElementById("safety-radius-input");
const etaMaxInput = document.getElementById("eta-max-input");
const radarRangeFill = document.getElementById("radar-range-fill");
const safetyRangeFill = document.getElementById("safety-range-fill");
const etaRangeFill = document.getElementById("eta-range-fill");
const radarValueEl = document.getElementById("radar-radius-value");
const safetyValueEl = document.getElementById("safety-radius-value");
const etaMaxValueEl = document.getElementById("eta-max-value");
const altRangeInput = document.getElementById("alt-range-input");
const altRangeFill = document.getElementById("alt-range-fill");
const altRangeValueEl = document.getElementById("alt-range-value");

const approachListEl = document.getElementById("approach-list");
const floatingForm = document.querySelector(".floating-form");
const floatingTrigger = document.getElementById("fake-form-trigger");
const closeFakeFormBtn = document.getElementById("close-fake-form");
const detailPanel = document.getElementById("detail-panel");
const detailCloseBtn = document.getElementById("detail-close");
const detailCallsign = document.getElementById("detail-callsign");
const detailHex = document.getElementById("detail-hex");
const detailPos = document.getElementById("detail-pos");
const detailAlt = document.getElementById("detail-alt");
const detailSpeed = document.getElementById("detail-speed");
const detailTrack = document.getElementById("detail-track");
const detailSquawk = document.getElementById("detail-squawk");
const detailCountry = document.getElementById("detail-country");
const detailNote = document.getElementById("detail-note");
const detailDeleteFake = document.getElementById("detail-delete-fake");
const detailPhoto = document.getElementById("detail-photo");
const detailImage = document.getElementById("detail-image");
const mapBrightnessInput = document.getElementById("map-brightness");
const mapBrightnessValue = document.getElementById("map-brightness-value");
const etaStatRow = document.querySelector(".stat-row span#eta")?.parentElement || null;
let isFakeFormOpen = false;
let detailImageHex = null;
let lastSafetyAlertAt = 0;
const SAFETY_ALERT_COOLDOWN_MS = 10000; // 현재는 미사용(재알림 막기용)
let alertedSafetyHexes = new Set();
if (warnEl) warnEl.style.display = "none";
if (etaStatRow) etaStatRow.style.display = "none";
if (etaStatRow) etaStatRow.style.display = "none";

// PWA/Push DOM
const pushStatusEl = document.getElementById("push-status");
const pushEnableBtn = document.getElementById("push-enable");
const pushTestBtn = document.getElementById("push-test");
const installBtn = document.getElementById("install-btn");
const mobileInstallSheet = document.getElementById("mobile-install-sheet");
const mobileInstallDownloadBtn = document.getElementById("mobile-install-download");
const mobileInstallDismissBtn = null;
const mobileInstallCloseBtn = null;
const mobileInstallHint = document.getElementById("mobile-install-hint");
const MOBILE_INSTALL_DISMISS_KEY = "mobileInstallDismissed";
const MOBILE_UA_REGEX = /(android|iphone|ipad|mobi)/i;

// PWA helpers
let swRegistration = null;
let deferredInstallPrompt = null;
const VAPID_PUBLIC_KEY_ENDPOINT = "/vapid-public-key";

function setPushStatus(text, tone = "idle") {
  if (!pushStatusEl) return;
  pushStatusEl.textContent = text;
  pushStatusEl.classList.remove("pill-idle", "pill-warn", "pill-muted");
  if (tone === "warn") {
    pushStatusEl.classList.add("pill-warn");
  } else if (tone === "muted") {
    pushStatusEl.classList.add("pill-muted");
  } else if (tone === "idle") {
    pushStatusEl.classList.add("pill-idle");
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    setPushStatus("서비스워커 미지원", "warn");
    pushEnableBtn?.setAttribute("disabled", "disabled");
    pushTestBtn?.setAttribute("disabled", "disabled");
    return null;
  }
  if (swRegistration) return swRegistration;
  try {
    swRegistration = await navigator.serviceWorker.register("/sw.js");
    swRegistration = await navigator.serviceWorker.ready;
    setPushStatus("PWA 준비됨", "idle");
    return swRegistration;
  } catch (e) {
    console.warn("SW register failed", e);
    setPushStatus("서비스워커 등록 실패", "warn");
    return null;
  }
}

async function saveSubscription(subscription) {
  try {
    await fetch("/api/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription }),
    });
  } catch (e) {
    console.warn("subscription save failed", e);
  }
}

async function ensurePushActive() {
  const reg = await registerServiceWorker();
  if (!reg) return false;
  if (!("Notification" in window) || !("PushManager" in window)) {
    setPushStatus("푸시 미지원", "warn");
    pushEnableBtn?.setAttribute("disabled", "disabled");
    pushTestBtn?.setAttribute("disabled", "disabled");
    return false;
  }

  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") {
    setPushStatus("알림 권한 거부됨", "warn");
    return false;
  }

  let subscription = await reg.pushManager.getSubscription();
  try {
    if (!subscription) {
      const res = await fetch(VAPID_PUBLIC_KEY_ENDPOINT, { cache: "no-store" });
      if (!res.ok) throw new Error("VAPID 키 가져오기 실패");
      const vapidKey = (await res.text()).trim();
      const appServerKey = urlBase64ToUint8Array(vapidKey);
      subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appServerKey });
    }
    await saveSubscription(subscription);
    setPushStatus("알림 활성화", "success");
    pushEnableBtn?.setAttribute("disabled", "disabled");
    return true;
  } catch (e) {
    console.warn("push subscription failed", e);
    setPushStatus("구독 실패", "warn");
    return false;
  }
}

async function sendTestPush() {
  const ready = await ensurePushActive();
  if (!ready) return;
  try {
    const res = await fetch("/api/push/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "ADS-B 테스트 알림",
        body: "테스트 알림이 도착했습니다.",
        url: "/",
      }),
    });
    if (!res.ok) throw new Error(`테스트 알림 실패 (${res.status})`);
    setPushStatus("테스트 알림 전송", "success");
  } catch (e) {
    console.warn("test push failed", e);
    setPushStatus("테스트 알림 실패", "warn");
  }
}

async function sendSafetyPush(entries = []) {
  if (!entries.length) return;
  const ready = await ensurePushActive();
  if (!ready) return;
  try {
    // 중복 푸시 알림 방지를 위해 현재는 미사용
    return;
  } catch (e) {
    console.warn("safety push send failed", e);
  }
}

function isStandaloneMode() {
  return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
}

function isMobileEnvironment() {
  const ua = (navigator.userAgent || "").toLowerCase();
  const matchesUa = MOBILE_UA_REGEX.test(ua);
  const isNarrow = window.innerWidth <= 768;
  return matchesUa && isNarrow;
}

function setMobileInstallHint(text) {
  if (!mobileInstallHint) return;
  if (text) {
    mobileInstallHint.textContent = text;
    mobileInstallHint.hidden = false;
  } else {
    mobileInstallHint.hidden = true;
  }
}

function dismissMobileInstall(permanent = false) {
  // 모바일 환경에서는 설치 안내만 노출해야 하므로 닫기 동작을 무시
  if (isMobileEnvironment()) {
    return;
  }
  if (permanent) {
    try {
      localStorage.setItem(MOBILE_INSTALL_DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
  }
  if (mobileInstallSheet) mobileInstallSheet.classList.remove("is-visible");
}

function shouldShowMobileInstallPrompt() {
  return Boolean(mobileInstallSheet) && isMobileEnvironment() && !isStandaloneMode();
}

function updateMobileInstallVisibility(forceHide = false) {
  if (!mobileInstallSheet) return;
  const isMobile = isMobileEnvironment();
  const shouldShow = !forceHide && isMobile;

  if (!shouldShow) {
    document.body.classList.remove("mobile-lock");
    mobileInstallSheet.classList.remove("is-visible");
    return;
  }

  document.body.classList.add("mobile-lock");
  mobileInstallSheet.classList.add("is-visible");
}

async function promptInstallAndShortcut() {
  registerServiceWorker();
  setMobileInstallHint("");
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    let choice = null;
    try {
      choice = await deferredInstallPrompt.userChoice;
    } catch (e) {
      console.warn("install prompt failed", e);
    }
    deferredInstallPrompt = null;
    installBtn?.classList.add("hidden");
    if (choice?.outcome === "accepted") {
      setMobileInstallHint("설치가 완료되면 홈 화면에 바로가기 아이콘이 자동으로 생성됩니다.");
      return;
    }
  }
  setMobileInstallHint("브라우저 메뉴의 '홈 화면에 추가'를 눌러 홈 화면 바로가기를 만들어주세요.");
}

function initPwaUi() {
  registerServiceWorker();

  const refreshMobilePrompt = () => updateMobileInstallVisibility();

  pushEnableBtn?.addEventListener("click", () => {
    setPushStatus("권한 확인 중..", "muted");
    ensurePushActive();
  });
  pushTestBtn?.addEventListener("click", () => {
    setPushStatus("테스트 알림 준비중..", "muted");
    sendTestPush();
  });

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installBtn?.classList.remove("hidden");
    refreshMobilePrompt();
  });

  installBtn?.addEventListener("click", () => {
    promptInstallAndShortcut();
  });

  window.addEventListener("appinstalled", () => {
    installBtn?.classList.add("hidden");
    dismissMobileInstall(true);
    setMobileInstallHint("홈 화면에 바로가기 아이콘이 추가되었습니다.");
  });

  mobileInstallDownloadBtn?.addEventListener("click", () => {
    promptInstallAndShortcut();
  });

  const handleDismiss = () => dismissMobileInstall(true);
  mobileInstallDismissBtn?.addEventListener("click", handleDismiss);
  mobileInstallCloseBtn?.addEventListener("click", handleDismiss);

  window.addEventListener("resize", refreshMobilePrompt);
  refreshMobilePrompt();
}

async function notifySafety(entries = []) {
  if (!entries.length || !("Notification" in window)) return;
  if (Notification.permission === "default") {
    try {
      await Notification.requestPermission();
    } catch {
      /* ignore */
    }
  }
  if (Notification.permission !== "granted") return;

  const title = `안전반경 침입: ${entries.length}대`;
  const body = entries
    .map((e) => `${e.call || e.hex || "unknown"} (${e.dist?.toFixed?.(1) || "?"}km)`)
    .join(", ");
  const options = {
    body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: "/" },
  };

  try {
    const reg = await registerServiceWorker();
    if (reg?.showNotification) {
      reg.showNotification(title, options);
      return;
    }
  } catch {
    /* ignore */
  }
  try {
    new Notification(title, options);
  } catch (e) {
    console.warn("Notification failed", e);
  }
}

function altitudeMeters(ac) {
  const raw = ac?.alt_baro ?? ac?.alt_geom ?? ac?.altitude ?? null;
  const ft = Number(raw);
  if (!Number.isFinite(ft)) return null;
  return ft * FT_TO_M;
}

function altitudeKilometers(ac) {
  const meters = altitudeMeters(ac);
  return Number.isFinite(meters) ? meters / 1000 : null;
}

function hexToRgb(hex) {
  const v = hex.replace("#", "");
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

function lerpColor(a, b, t) {
  const clamped = Math.min(Math.max(t, 0), 1);
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const rr = Math.round(ar + (br - ar) * clamped);
  const rg = Math.round(ag + (bg - ag) * clamped);
  const rb = Math.round(ab + (bb - ab) * clamped);
  return `#${rr.toString(16).padStart(2, "0")}${rg.toString(16).padStart(2, "0")}${rb.toString(16).padStart(2, "0")}`;
}

// -1.0(진하게/어둡게) ~ 1.0(밝게) 보정
function adjustColor(hex, t = 0) {
  const [r, g, b] = hexToRgb(hex);
  const clamp = (v) => Math.min(255, Math.max(0, Math.round(v)));
  const mix = (ch) => (t >= 0 ? ch + (255 - ch) * t : ch * (1 + t));
  return `#${clamp(mix(r)).toString(16).padStart(2, "0")}${clamp(mix(g)).toString(16).padStart(2, "0")}${clamp(mix(b)).toString(16).padStart(2, "0")}`;
}

function isWithinCylinder(target, other, radiusKm, options = {}) {
  const ignoreAltitude = options.ignoreAltitude === true;
  if (!Number.isFinite(target?.lat) || !Number.isFinite(target?.lon)) return false;
  if (!Number.isFinite(other?.lat) || !Number.isFinite(other?.lon)) return false;
  const distKm = haversineKm(target.lat, target.lon, other.lat, other.lon);
  if (ignoreAltitude) return distKm <= radiusKm;

  const altO = altitudeMeters(other);
  const withinRange = distKm <= radiusKm;
  if (!withinRange) return false;

  // 고도가 없으면 수평 반경만으로 통과 처리
  if (!Number.isFinite(altO)) return true;

  // 슬라이더가 절대 고도(km) 범위를 의미하므로 절대 고도만 확인
  return altO >= altitudeToleranceMinM && altO <= altitudeToleranceMaxM;
}

// 고도별 색상: 저고도 진/밝은 초록, 중고도 진/밝은 블루, 고고도 진/밝은 보라
function altitudeToColor(ac) {
  const altM = Math.max(0, Number.isFinite(altitudeMeters(ac)) ? altitudeMeters(ac) : 0);
  const bands = [
    // 저고도: 밝은 블루 (레이더/안전 반경 색과 겹치지 않도록 블루 계열)
    { max: 2000, from: adjustColor("#00A8FF", -0.15), to: adjustColor("#00A8FF", 0.25) },
    // 중고도: 선명한 그린
    { max: 8000, from: adjustColor("#22C55E", -0.15), to: adjustColor("#22C55E", 0.25) },
    // 고고도: 강한 퍼플
    { max: Infinity, from: adjustColor("#A855F7", -0.15), to: adjustColor("#A855F7", 0.25) },
  ];

  let prevMax = 0;
  for (const band of bands) {
    if (altM <= band.max) {
      const range = band.max - prevMax;
      const t = !Number.isFinite(range) ? 0 : (altM - prevMax) / Math.max(range, 1);
      return lerpColor(band.from, band.to, t);
    }
    prevMax = band.max;
  }
  return bands[bands.length - 1].to;
}

function pickColor(ac) {
  const color = altitudeToColor(ac);
  if (ac?.hex) colors.set(ac.hex, color);
  return color;
}

function lightenHex(hex, factor = 1.2) {
  const [r, g, b] = hexToRgb(hex);
  const lr = Math.min(Math.round(r * factor), 255);
  const lg = Math.min(Math.round(g * factor), 255);
  const lb = Math.min(Math.round(b * factor), 255);
  return `#${lr.toString(16).padStart(2, "0")}${lg.toString(16).padStart(2, "0")}${lb.toString(16).padStart(2, "0")}`;
}

function setMapBrightness(value) {
  const min = parseFloat(mapBrightnessInput?.min || "10");
  const max = parseFloat(mapBrightnessInput?.max || "100");
  let num = Number(value);
  if (!Number.isFinite(num)) num = parseFloat(mapBrightnessInput?.value || `${MAP_BRIGHTNESS_DEFAULT}`);
  const clamped = Math.min(Math.max(num, min), max);
  if (mapBrightnessInput) mapBrightnessInput.value = clamped;
  if (mapBrightnessValue) mapBrightnessValue.textContent = `${Math.round(clamped)}%`;
  document.documentElement.style.setProperty("--tile-brightness", (clamped / 100).toFixed(2));
}

function formatAltitudeKilometers(ac, maxFractionDigits = 1) {
  const km = altitudeKilometers(ac);
  if (km === null) return "-";
  return Number.isFinite(km)
    ? km.toLocaleString("en-US", { maximumFractionDigits: maxFractionDigits })
    : "-";
}

function normalizeHex(hex) {
  return (hex || "").trim().toUpperCase();
}

function resolveActualHex(hex) {
  const target = normalizeHex(hex);
  const match = latestAircraft.find((p) => normalizeHex(p.hex) === target);
  return match?.hex || hex;
}

function createIcon(ac, color, isSelected, shape = "plane") {
  const heading = Number.isFinite(ac.track) ? ac.track : 0;
  const fill = isSelected ? lightenHex(color, 1.15) : color;
  const outline = isSelected ? "rgba(0,0,0,0.45)" : "none";
  const planeSvg = `<path d="M2 13l1.5-2 7-1 1-6h1l1 6 7 1 1.5 2-1.5 2-7 1-1 6h-1l-1-6-7-1z" stroke="${outline}" stroke-width="1.5" stroke-linejoin="round" />`;
  const droneSvg = `
      <circle cx="5" cy="5" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.82" />
      <circle cx="19" cy="5" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.82" />
      <circle cx="5" cy="19" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.82" />
      <circle cx="19" cy="19" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.82" />
      <path d="M11.25 3c0-.7.55-1.25 1.25-1.25S13.75 2.3 13.75 3v3.2l1.7-1.7a1 1 0 0 1 1.4 1.4L14.5 8.3H17c.7 0 1.25.55 1.25 1.25S17.7 10.8 17 10.8h-2.5l1.7 1.7a1 1 0 1 1-1.4 1.4L13.75 12V15c0 .7-.55 1.25-1.25 1.25S11.25 15.7 11.25 15V12l-1.7 1.7a1 1 0 0 1-1.4-1.4l1.7-1.7H7c-.7 0-1.25-.55-1.25-1.25S6.3 8.3 7 8.3h2.5L7.8 5.9a1 1 0 0 1 1.4-1.4l2.05 2.05z" stroke="${outline}" stroke-width="1.2" stroke-linejoin="round" />
      <path d="M12 4.3 13.2 6.5h-2.4L12 4.3z" />
      <circle cx="12" cy="12" r="2.2" />`;
  const body = shape === "drone" ? droneSvg : planeSvg;
  return L.divIcon({
    className: `plane-icon${isSelected ? " selected" : ""}`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    html: `<svg viewBox="0 0 24 24" width="30" height="30" style="transform: rotate(${heading}deg); color:${fill};" fill="currentColor">${body}</svg>`
  });
}

// 상단 상태바 텍스트 업데이트
function updateStats(total, withPos) {
  statsEl.textContent = `Aircraft: ${total} | With position: ${withPos}`;
}

// 콜사인 표시값 정규화
function formatCallsign(ac) {
  const c = (ac.flight || "").trim();
  return c || ac.hex;
}

// 테이블 렌더링 + 필터 적용
function renderTable(list) {
  const filter = searchInput.value.trim().toLowerCase();
  const filtered = list.filter((ac) => {
    const cs = formatCallsign(ac).toLowerCase();
    return !filter || cs.includes(filter) || ac.hex.toLowerCase().includes(filter);
  });

  filtered.sort((a, b) => formatCallsign(a).toLowerCase().localeCompare(formatCallsign(b).toLowerCase()));

  const rows = filtered.map((ac) => {
    const alt = formatAltitudeKilometers(ac);
    const lat = Number.isFinite(ac.lat) ? ac.lat.toFixed(4) : "-";
    const lon = Number.isFinite(ac.lon) ? ac.lon.toFixed(4) : "-";
    const selectedClass = ac.hex === selectedHex ? ' class="selected"' : "";
    return `<tr data-hex="${ac.hex}"${selectedClass}>
      <td>${formatCallsign(ac)}</td>
      <td>${lat}</td>
      <td>${lon}</td>
      <td>${alt}</td>
    </tr>`;
  }).join("");

  tableBody.innerHTML = rows;
  scrollToSelectedRow();
}

// 선택된 기체의 마커/아이콘 강조
function refreshSelectedIcons() {
  markers.forEach((entry, hex) => {
    const ac = latestAircraft.find((p) => p.hex === hex);
    if (!ac) return;
    const base = pickColor(ac);
    const color = getAlertColor(ac) || base;
    const isFake = fakePlanes.some((f) => f.hex === hex);
    const shape = isFake ? "drone" : "plane";
    entry.marker.setIcon(createIcon(ac, color, hex === selectedHex, shape));
    if (trailLines.has(hex)) {
      trailLines.get(hex).setStyle({ color });
    }
  });
  updateTrailStyles();
}

// 지도, 마커, 궤적, 오버레이를 최신 데이터에 맞춰 갱신
function updateMap(aircraft, fakeSet = new Set()) {
  const now = Date.now();
  const seen = new Set();

  aircraft.forEach((ac) => {
    if (!Number.isFinite(ac.lat) || !Number.isFinite(ac.lon)) return;
    const hex = ac.hex;
    const pos = [ac.lat, ac.lon];
    seen.add(hex);

    const base = pickColor(ac);
    const color = getAlertColor(ac) || base;
    const icon = createIcon(ac, color, hex === selectedHex);

    if (!markers.has(hex)) {
      const marker = L.marker(pos, { icon });
      marker.addTo(map);
      marker.on("click", () => {
        selectedHex = hex;
        refreshSelectedIcons();
        renderTable(latestAircraft);
        openDetailForHex(hex);
        // Use current marker location in case it has moved since creation
        const currentPos = marker.getLatLng();
        map.flyTo(currentPos, map.getZoom());
      });
      markers.set(hex, { marker, lastSeen: now, dragging: false });
    } else {
      const entry = markers.get(hex);
      entry.lastSeen = now;
      if (!entry.dragging) {
        entry.marker.setLatLng(pos);
        entry.marker.setIcon(icon);
      }
    }

    const history = trails.get(hex) || [];
    history.push(pos);
    if (history.length > MAX_TRAIL_POINTS) history.shift();
    trails.set(hex, history);

    if (!trailLines.has(hex)) {
      const line = L.polyline(history, { color, weight: 2, opacity: 0.4 });
      line.addTo(map);
      trailLines.set(hex, line);
    } else {
      const line = trailLines.get(hex);
      line.setLatLngs(history);
      line.setStyle({ color });
    }
  });
  updateTrailStyles();

  markers.forEach((entry, hex) => {
    if (seen.has(hex)) return;
    if (fakeSet.has(hex)) return; // 가짜 마커는 그대로 유지
    if (now - entry.lastSeen > STALE_MS) {
      map.removeLayer(entry.marker);
      markers.delete(hex);
      if (trailLines.has(hex)) {
        map.removeLayer(trailLines.get(hex));
        trailLines.delete(hex);
      }
      trails.delete(hex);
      colors.delete(hex);
    }
  });
}

// 주기적으로 ADS-B 데이터를 받아 UI 반영
async function poll() {
  try {
    const t0 = performance.now();
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const elapsed = performance.now() - t0;
    if (pingEl) pingEl.textContent = `Ping: ${Math.round(elapsed)} ms`;

    const aircraft = Array.isArray(data.aircraft) ? data.aircraft : [];
    const withPos = aircraft.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));

    const combined = [...withPos, ...fakePlanes];
    const fakeSet = new Set(fakePlanes.map((f) => f.hex));

    latestAircraft = combined;
    updateStats(combined.length, combined.length);
    updateMap(combined, fakeSet);
    updateFakeStats(combined);
    renderTable(combined);
    if (selectedHex) openDetailForHex(selectedHex);
  } catch (err) {
    console.error("Fetch error", err);
    statsEl.textContent = "Error fetching data";
    if (pingEl) pingEl.textContent = "Ping: error";
  } finally {
    setTimeout(poll, pollMs);
  }
}

if (mapBrightnessInput && !mapBrightnessInput.value) {
  mapBrightnessInput.value = MAP_BRIGHTNESS_DEFAULT;
}
setMapBrightness(mapBrightnessInput?.value || MAP_BRIGHTNESS_DEFAULT);
const applyBrightness = () => setMapBrightness(mapBrightnessInput?.value);
mapBrightnessInput?.addEventListener("change", applyBrightness);
mapBrightnessInput?.addEventListener("blur", applyBrightness);
mapBrightnessInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") applyBrightness();
});

searchInput.addEventListener("input", () => renderTable(latestAircraft));
clearFilter.addEventListener("click", () => {
  searchInput.value = "";
  renderTable(latestAircraft);
});

tableBody.addEventListener("click", (e) => {
  const row = e.target.closest("tr[data-hex]");
  if (!row) return;
  suppressAutoSelect = true;
  const hex = row.dataset.hex;
  selectedHex = hex;
  refreshSelectedIcons();
  renderTable(latestAircraft);
  openDetailForHex(hex);
  const entry = markers.get(hex);
  if (entry) map.flyTo(entry.marker.getLatLng(), map.getZoom());
});

function scrollToSelectedRow() {
  if (!selectedHex) return;
  const row = tableBody.querySelector(`tr[data-hex="${selectedHex}"]`);
  if (row) {
    row.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

function formatNumber(val, digits = 1) {
  return Number.isFinite(val) ? val.toFixed(digits) : "-";
}

function updateDetailImage(ac) {
  if (!detailPhoto || !detailImage) return;
  if (!ac || !ac.hex) {
    detailImageHex = null;
    detailImage.removeAttribute("src");
    detailPhoto.hidden = true;
    detailPhoto.classList.remove("loading");
    return;
  }
  const hex = normalizeHex(ac.hex);
  const shouldReload = detailImageHex !== hex || !detailImage.src;
  detailImageHex = hex;
  detailPhoto.hidden = false;
  if (shouldReload) {
    detailPhoto.classList.add("loading");
    detailImage.onload = () => detailPhoto.classList.remove("loading");
    detailImage.onerror = () => detailPhoto.classList.remove("loading");
    detailImage.src = `/api/plane-image?hex=${encodeURIComponent(hex)}`;
  }
  const call = formatCallsign(ac);
  detailImage.alt = call ? `${call} (${hex})` : `${hex} image`;
}

function setDetail(ac) {
  if (!detailPanel) return;
  if (!ac) {
    detailPanel.hidden = true;
    updateDetailImage(null);
    if (detailDeleteFake) detailDeleteFake.hidden = true;
    return;
  }
  detailPanel.hidden = false;
  detailCallsign.textContent = formatCallsign(ac);
  detailHex.textContent = `Hex: ${ac.hex || "-"}`;
  const lat = Number.isFinite(ac.lat) ? ac.lat.toFixed(4) : "-";
  const lon = Number.isFinite(ac.lon) ? ac.lon.toFixed(4) : "-";
  detailPos.textContent = `${lat}, ${lon}`;
  detailAlt.textContent = `${formatAltitudeKilometers(ac)} km`;
  const gs = Number.isFinite(ac.gs) ? ac.gs : null;
  detailSpeed.textContent = gs !== null ? `${gs.toFixed(1)} kt` : "-";
  detailTrack.textContent = Number.isFinite(ac.track) ? `${ac.track.toFixed(1)}\u00b0` : "-";
  detailSquawk.textContent = ac.squawk || "-";
  detailCountry.textContent = ac.r ? ac.r : "-";
  detailNote.textContent = ac.category ? `Category: ${ac.category}` : "ADS-B Live";
  updateDetailImage(ac);

  const isFake = fakePlanes.some((f) => f.hex === ac.hex);
  if (detailDeleteFake) {
    detailDeleteFake.hidden = !isFake;
    detailDeleteFake.dataset.hex = ac.hex || "";
  }
}
function closeDetail() {
  detailPanel.hidden = true;
  updateDetailImage(null);
  selectedHex = null;
  suppressAutoSelect = true;
  refreshSelectedIcons();
  renderTable(latestAircraft);
}

function openDetailForHex(hex) {
  const targetHex = normalizeHex(hex);
  const ac = latestAircraft.find((p) => normalizeHex(p.hex) === targetHex);
  setDetail(ac || null);
}

function removeFake(hex) {
  if (!hex) return;
  const wasSelected = selectedHex === hex;
  fakePlanes = fakePlanes.filter((f) => f.hex !== hex);
  latestAircraft = latestAircraft.filter((p) => p.hex !== hex);
  suppressAutoSelect = false;
  alertedSafetyHexes = new Set();
  lastSafetyHexes = new Set();
  lastSafetyAlertAt = 0;

  if (markers.has(hex)) {
    map.removeLayer(markers.get(hex).marker);
    markers.delete(hex);
  }
  if (trailLines.has(hex)) {
    map.removeLayer(trailLines.get(hex));
    trailLines.delete(hex);
  }
  trails.delete(hex);
  colors.delete(hex);
  if (fakeOverlays.has(hex)) {
    const ov = fakeOverlays.get(hex);
    map.removeLayer(ov.radar);
    map.removeLayer(ov.safety);
    fakeOverlays.delete(hex);
  }
  if (sectorOverlays.has(hex)) {
    sectorOverlays.get(hex).forEach((layer) => map.removeLayer(layer));
    sectorOverlays.delete(hex);
  }

  renderTable(latestAircraft);
  updateStats(latestAircraft.length, latestAircraft.length);
  updateFakeStats(latestAircraft);
  if (wasSelected) {
    closeDetail();
  } else {
    refreshSelectedIcons();
  }
}

function updateTrailStyles() {
  trailLines.forEach((line, hex) => {
    const ac = latestAircraft.find((p) => p.hex === hex);
    const base = ac ? pickColor(ac) : line.options.color;
    const color = (ac && getAlertColor(ac)) || base;
    const isSel = hex === selectedHex;
    line.setStyle({
      color,
      weight: isSel ? 4 : 2,
      opacity: isSel ? 0.85 : 0,
    });
    if (isSel) line.bringToFront();
  });
}

function findClosestToFake() {
  if (!fakePlanes.length) return null;
  const target = fakePlanes[fakePlanes.length - 1];
  if (!Number.isFinite(target.lat) || !Number.isFinite(target.lon)) return null;
  let closest = null;
  latestAircraft.forEach((p) => {
    if (!p || p.hex === target.hex) return;
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return;
    const distKm = haversineKm(target.lat, target.lon, p.lat, p.lon);
    if (distKm > safetyRadiusKm) return;
    if (!closest || distKm < closest.distKm) {
      closest = { ac: p, distKm };
    }
  });
  return closest;
}

function updateClearSectors(target, aircraft) {
  if (!target) return;
  const hex = target.hex;
  // 기존 부채꼴 제거
  if (sectorOverlays.has(hex)) {
    sectorOverlays.get(hex).forEach((layer) => map.removeLayer(layer));
    sectorOverlays.delete(hex);
  }

  const segments = 24; // 15도 단위
  const step = 360 / segments;
  const occupied = new Array(segments).fill(false);

  aircraft.forEach((p) => {
    if (p.hex === hex) return;
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return;
    if (!isWithinCylinder(target, p, safetyRadiusKm)) return;
    const bearing = bearingDeg(target.lat, target.lon, p.lat, p.lon);
    const idx = Math.floor((bearing % 360) / step);
    occupied[idx] = true;
  });

  const layers = [];
  for (let i = 0; i < segments; i++) {
    // 이동할 수 없는 방향(기체가 있는 섹터)만 표시
    if (!occupied[i]) continue;
    const start = i * step;
    const end = start + step;
    const mid = start + step / 2;
    const a = destinationPoint(target.lat, target.lon, start, safetyRadiusKm);
    const b = destinationPoint(target.lat, target.lon, mid, safetyRadiusKm);
    const c = destinationPoint(target.lat, target.lon, end, safetyRadiusKm);
    const poly = L.polygon(
      [
        [target.lat, target.lon],
        a,
        b,
        c,
      ],
      {
        color: "none", // 부채꼴 경계선 제거 (현 표시 없음)
        fillColor: "rgba(239, 68, 68, 0.45)",
        fillOpacity: 0.65,
        weight: 0,
        interactive: false,
      }
    );
    poly.addTo(map);
    layers.push(poly);
  }

  if (layers.length) {
    sectorOverlays.set(hex, layers);
  }
}

function openFakeForm() {
  isFakeFormOpen = true;
  floatingForm?.classList.add("open");
  floatingTrigger?.classList.add("hidden");
}

function closeFakeForm() {
  isFakeFormOpen = false;
  floatingForm?.classList.remove("open");
  floatingTrigger?.classList.remove("hidden");
}

// 단일 슬라이더 채움 너비 계산
function setSingleFill(input, fillEl) {
  if (!input || !fillEl) return;
  const min = parseFloat(input.min || "0");
  const max = parseFloat(input.max || "100");
  const val = parseFloat(input.value || min);
  const pct = ((val - min) / (max - min || 1)) * 100;
  const clamped = Math.min(Math.max(pct, 0), 100);
  fillEl.style.width = `${clamped}%`;
}

// 듀얼 슬라이더 채움 영역 계산 (ETA / 고도 공용)
function updateRangeFill(minInput, maxInput, fillEl) {
  if (!fillEl || !minInput || !maxInput) return;
  const minRange = parseFloat(minInput.min || "0");
  const maxRange = parseFloat(minInput.max || "100");
  const minVal = Math.min(parseFloat(minInput.value || "0"), parseFloat(maxInput.value || "0"));
  const maxVal = Math.max(parseFloat(minInput.value || "0"), parseFloat(maxInput.value || "0"));
  const range = maxRange - minRange || 1;
  const left = Math.min(Math.max(((minVal - minRange) / range) * 100, 0), 100);
  const right = Math.min(Math.max(((maxVal - minRange) / range) * 100, 0), 100);
  fillEl.style.left = `${left}%`;
  fillEl.style.width = `${Math.max(right - left, 0)}%`;
}

function updateEtaFill() {
  setSingleFill(etaMaxInput, etaRangeFill);
}

function updateAltFill() {
  setSingleFill(altRangeInput, altRangeFill);
}

// ETA 슬라이더 범위 보정 및 값 동기화
function syncEtaRange(shouldUpdateStats = true) {
  if (!etaMaxInput) return;
  const minRange = parseFloat(etaMaxInput.min || "0");
  const maxRange = parseFloat(etaMaxInput.max || "10");
  const typedMax = parseFloat(etaMaxInput.value || etaMaxValueEl?.value || `${maxRange}`);
  let maxVal = typedMax;

  if (!Number.isFinite(maxVal)) maxVal = maxRange;
  maxVal = Math.max(minRange, Math.min(maxVal, maxRange));

  etaMaxInput.value = maxVal;
  if (etaMaxValueEl) etaMaxValueEl.value = Math.round(maxVal);

  updateEtaFill();
  if (shouldUpdateStats) {
    updateFakeStats(latestAircraft);
  }
}

function syncAltRange(shouldUpdateStats = true) {
  if (!altRangeInput) return;
  const minRange = parseFloat(altRangeInput.min || "0");
  const maxRange = parseFloat(altRangeInput.max || "6"); // km
  const typedVal = parseFloat(altRangeInput.value || altRangeValueEl?.value || `${maxRange}`);
  let val = Number.isFinite(typedVal) ? typedVal : maxRange;
  val = Math.max(minRange, Math.min(val, maxRange));
  altRangeInput.value = val;
  altitudeToleranceMinM = 0;
  altitudeToleranceMaxM = val * 1000;
  if (altRangeValueEl) altRangeValueEl.value = parseFloat(val.toFixed(1));

  updateAltFill();
  if (shouldUpdateStats) {
    updateFakeStats(latestAircraft);
    refreshSelectedIcons();
  }
}

// 가짜 기체 입력 요소
const fakeCallsign = document.getElementById("fake-callsign");
const fakeLat = document.getElementById("fake-lat");
const fakeLon = document.getElementById("fake-lon");
const fakeAlt = document.getElementById("fake-alt");
const addFakeBtn = document.getElementById("add-fake");

// 입력값으로 가짜 기체 생성 (미입력 시 placeholder 활용)
function createFakePlane() {
  suppressAutoSelect = false;
  const latStr = fakeLat.value.trim() || fakeLat.placeholder || "";
  const lonStr = fakeLon.value.trim() || fakeLon.placeholder || "";
  const altStr = fakeAlt.value.trim() || fakeAlt.placeholder || "";
  const lat = parseFloat(latStr);
  const lon = parseFloat(lonStr);
  const alt = parseFloat(altStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    alert("Lat/Lon을 올바르게 입력하세요.");
    return;
  }
  const existingFakes = [...fakePlanes];
  existingFakes.forEach((f) => removeFake(f.hex));
  const hex = `FAKE${Date.now().toString(16).slice(-4)}`;
  const flight = (fakeCallsign.value.trim() || fakeCallsign.placeholder || hex).toUpperCase();
  const altFt = Number.isFinite(alt) ? alt / FT_TO_M : 0; // 입력은 미터, 내부는 ft로 저장
  const plane = { hex, flight, lat, lon, alt_baro: altFt };
  fakePlanes = [plane];
  lastSafetyHexes = new Set();
  lastSafetyAlertAt = 0;
  alertedSafetyHexes = new Set();
  addOrUpdateFakeMarker(plane);
  latestAircraft = [...latestAircraft.filter((p) => p.hex !== hex), plane];
  renderTable(latestAircraft);
  updateStats(latestAircraft.length, latestAircraft.length);
  updateFakeStats(latestAircraft, { forceClosestSelection: true });
}

// 가짜 기체 마커/반경 오버레이 생성 또는 갱신
function addOrUpdateFakeMarker(plane) {
  const hex = plane.hex;
  const pos = [plane.lat, plane.lon];
  const base = pickColor(plane);
  const color = getAlertColor(plane) || base;
  const icon = createIcon(plane, color, hex === selectedHex);
  if (!markers.has(hex)) {
    const marker = L.marker(pos, { icon, draggable: true });
    marker.addTo(map);
    marker.on("click", () => {
      suppressAutoSelect = true;
      selectedHex = hex;
      refreshSelectedIcons();
      renderTable(latestAircraft);
      openDetailForHex(hex);
      // Center on the marker’s current location (after any drag)
      const currentPos = marker.getLatLng();
      map.flyTo(currentPos, map.getZoom());
    });
    marker.on("dragstart", () => {
      const entry = markers.get(hex);
      if (entry) entry.dragging = true;
    });
    marker.on("dragend", (evt) => {
      const ll = evt.target.getLatLng();
      plane.lat = ll.lat;
      plane.lon = ll.lng;
      suppressAutoSelect = false;
      addOrUpdateFakeMarker(plane);
      refreshSelectedIcons();
      renderTable(latestAircraft);
      updateFakeStats(latestAircraft, { forceClosestSelection: true });
      const entry = markers.get(hex);
      if (entry) entry.dragging = false;
    });
    markers.set(hex, { marker, lastSeen: Date.now(), dragging: false });
  } else {
    const entry = markers.get(hex);
    entry.marker.setLatLng(pos);
    entry.marker.setIcon(icon);
    entry.lastSeen = Date.now();
  }

  // 레이더/안전 반경 원을 위치/반경에 맞게 갱신
  if (!fakeOverlays.has(hex)) {
    const radar = L.circle(pos, { radius: radarRadiusKm * 1000, color: "#38bdf8", weight: 1, opacity: 0.8, fillOpacity: 0.0 });
    const safety = L.circle(pos, { radius: safetyRadiusKm * 1000, color: "#f43f5e", weight: 1, opacity: 0.9, fillOpacity: 0.05, fillColor: "#f43f5e" });
    radar.addTo(map);
    safety.addTo(map);
    fakeOverlays.set(hex, { radar, safety });
  } else {
    const ov = fakeOverlays.get(hex);
    ov.radar.setLatLng(pos);
    ov.radar.setRadius(radarRadiusKm * 1000);
    ov.safety.setLatLng(pos);
    ov.safety.setRadius(safetyRadiusKm * 1000);
  }
  map.flyTo(pos, map.getZoom());
}

addFakeBtn.addEventListener("click", createFakePlane);
floatingTrigger?.addEventListener("click", openFakeForm);
closeFakeFormBtn?.addEventListener("click", closeFakeForm);
detailCloseBtn?.addEventListener("click", closeDetail);
detailDeleteFake?.addEventListener("click", () => removeFake(detailDeleteFake.dataset.hex));

// --- 거리/경고 계산 ---
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  return (toDeg(θ) + 360) % 360;
}

function destinationPoint(lat, lon, bearingDegVal, distanceKm) {
  const R = 6371;
  const δ = distanceKm / R;
  const θ = (bearingDegVal * Math.PI) / 180;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lon * Math.PI) / 180;

  const sinφ1 = Math.sin(φ1);
  const cosφ1 = Math.cos(φ1);
  const sinδ = Math.sin(δ);
  const cosδ = Math.cos(δ);
  const sinθ = Math.sin(θ);
  const cosθ = Math.cos(θ);

  const sinφ2 = sinφ1 * cosδ + cosφ1 * sinδ * cosθ;
  const φ2 = Math.asin(sinφ2);
  const y = sinθ * sinδ * cosφ1;
  const x = cosδ - sinφ1 * sinφ2;
  const λ2 = λ1 + Math.atan2(y, x);

  return [(φ2 * 180) / Math.PI, ((λ2 * 180) / Math.PI + 540) % 360 - 180];
}

function getAlertColor(ac) {
  if (!fakePlanes.length) return null;
  const target = fakePlanes[fakePlanes.length - 1];
  if (!target || target.hex === ac.hex) return null;
  if (!Number.isFinite(ac.lat) || !Number.isFinite(ac.lon)) return null;
  if (!Number.isFinite(target.lat) || !Number.isFinite(target.lon)) return null;
  if (isWithinCylinder(target, ac, safetyRadiusKm)) return "#ef4444"; // 안전 반경 내: 빨강
  if (isWithinCylinder(target, ac, radarRadiusKm, { ignoreAltitude: true })) return "#fbbf24";  // 레이더 반경 내: 노랑
  return null;
}

function updateFakeStats(aircraft, options = {}) {
  const forceClosestSelection = options.forceClosestSelection === true;
  warnEl.classList.remove("warn-active", "warn-soon");
  approachListEl.innerHTML = "";
  if (!fakePlanes.length) {
    radarCountEl.textContent = "0";
    warnEl.textContent = "가짜 기체가 없습니다.";
    return;
  }
  const target = fakePlanes[fakePlanes.length - 1];
  let radarCount = 0;
  let minEta = null;
  let immediateDanger = false;
  const safetyHits = [];
  const safetyDetails = [];

  const maxRangeRaw = parseFloat(etaMaxInput?.value || "10");
  const maxRange = Number.isFinite(maxRangeRaw) ? Math.max(0, maxRangeRaw) : 10;
  const etaLo = 0;
  const etaHi = maxRange;
  const approaching = [];

  aircraft.forEach((p) => {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return;
    if (p.hex === target.hex) return;
    const hex = normalizeHex(p.hex);
    if (!hex) return;
    const distKm = haversineKm(target.lat, target.lon, p.lat, p.lon);
    const inRadar = isWithinCylinder(target, p, radarRadiusKm, { ignoreAltitude: true });
    const inSafety = isWithinCylinder(target, p, safetyRadiusKm);

    if (inRadar) radarCount++;
    if (inSafety) {
      immediateDanger = true;
      safetyHits.push(hex);
      safetyDetails.push({ hex, rawHex: p.hex, call: formatCallsign(p), dist: distKm, lat: p.lat, lon: p.lon });
    } else if (p.gs) {
      const mps = p.gs * 0.514444;
      if (mps > 1) {
        const etaMin = ((distKm - safetyRadiusKm) * 1000) / mps / 60;
        if (etaMin >= 0 && (minEta === null || etaMin < minEta)) minEta = etaMin;
        if (!Number.isNaN(etaLo) && !Number.isNaN(etaHi) && etaMin >= etaLo && etaMin <= etaHi) {
          approaching.push({ call: formatCallsign(p), etaMin, hex: p.hex, lat: p.lat, lon: p.lon });
        }
      }
    }
  });

  const safetyList = safetyDetails
    .filter((d) => Number.isFinite(d.dist))
    .sort((a, b) => a.dist - b.dist);

  safetyList.forEach(({ call, hex, rawHex, dist, lat, lon }) => {
    const label = call || hex || "unknown";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = `${label} : ${dist.toFixed(1)} km`;
    const keyHex = rawHex || hex;
    if (keyHex) {
      btn.dataset.hex = keyHex;
      btn.classList.add("approach-item");
      btn.addEventListener("click", () => {
        const actualHex = resolveActualHex(keyHex);
        suppressAutoSelect = true;
        selectedHex = actualHex;
        refreshSelectedIcons();
        renderTable(latestAircraft);
        openDetailForHex(actualHex);
        const entry = markers.get(actualHex);
        if (entry) {
          map.flyTo(entry.marker.getLatLng(), map.getZoom());
        } else if (Number.isFinite(lat) && Number.isFinite(lon)) {
          map.flyTo([lat, lon], map.getZoom());
        }
      });
    }
    approachListEl.appendChild(btn);
  });

  radarCountEl.textContent = radarCount.toString();

  if (warnEl) {
    warnEl.textContent = "근접 위험 순위";
    warnEl.classList.remove("warn-active", "warn-soon");
  }

  const hadNoSafety = lastSafetyHexes.size === 0;
  const prev = new Set(lastSafetyHexes);
  lastSafetyHexes = new Set(safetyHits);
  const alertable = safetyDetails.filter((item) => !alertedSafetyHexes.has(item.hex));
  if (alertable.length > 0) {
    notifySafety(alertable);
    // 서버 푸시까지 보내면 브라우저 알림이 중복될 수 있어 로컬 알림만 사용
    alertable.forEach((item) => alertedSafetyHexes.add(item.hex));
    lastSafetyAlertAt = Date.now();
  }
  if (hadNoSafety && safetyHits.length > 0) {
    const firstHex = safetyHits[0];
    if (firstHex) {
      selectedHex = firstHex;
      suppressAutoSelect = false;
      refreshSelectedIcons();
      renderTable(latestAircraft);
      openDetailForHex(firstHex);
      const entry = markers.get(firstHex);
      if (entry) map.flyTo(entry.marker.getLatLng(), map.getZoom());
    }
  }

  updateClearSectors(target, aircraft);

  const closest = findClosestToFake();
  const userSelectedNonFake = selectedHex && !fakePlanes.some((f) => f.hex === selectedHex);
  const allowAutoSelect = forceClosestSelection || !suppressAutoSelect;
  const allowOverride = forceClosestSelection || !userSelectedNonFake;
  if (closest && allowAutoSelect && allowOverride) {
    selectedHex = closest.ac.hex;
    suppressAutoSelect = false;
    refreshSelectedIcons();
    renderTable(latestAircraft);
    openDetailForHex(selectedHex);
    if (detailNote) detailNote.textContent = `가장 가까운 기체까지 ${closest.distKm.toFixed(1)} km`;
  }
}

function applyManualRanges() {
  const radarMin = parseFloat(radarRadiusInput?.min || "1");
  const radarMax = parseFloat(radarRadiusInput?.max || "300");
  const safetyMin = parseFloat(safetyRadiusInput?.min || "1");
  const safetyMax = parseFloat(safetyRadiusInput?.max || "50");

  const readNumber = (el) => {
    if (!el) return NaN;
    const v = parseFloat(el.value || "");
    return Number.isFinite(v) ? v : NaN;
  };

  const radarFromInput = readNumber(radarRadiusInput);
  const radarFromField = readNumber(radarValueEl);
  const radarVal = Number.isFinite(radarFromInput) ? radarFromInput : radarFromField;
  if (Number.isFinite(radarVal)) {
    radarRadiusKm = Math.min(Math.max(radarVal, radarMin), radarMax);
  }

  const safetyFromInput = readNumber(safetyRadiusInput);
  const safetyFromField = readNumber(safetyValueEl);
  const safetyVal = Number.isFinite(safetyFromInput) ? safetyFromInput : safetyFromField;
  if (Number.isFinite(safetyVal)) {
    safetyRadiusKm = Math.min(Math.max(safetyVal, safetyMin), safetyMax, radarRadiusKm);
  }

  radarRadiusInput.value = Math.round(radarRadiusKm * 10) / 10;
  safetyRadiusInput.value = Math.round(safetyRadiusKm * 10) / 10;
  if (radarValueEl) radarValueEl.value = Math.round(radarRadiusKm * 10) / 10;
  if (safetyValueEl) safetyValueEl.value = Math.round(safetyRadiusKm * 10) / 10;
  setSingleFill(radarRadiusInput, radarRangeFill);
  setSingleFill(safetyRadiusInput, safetyRangeFill);

  fakeOverlays.forEach((ov) => {
    ov.radar.setRadius(radarRadiusKm * 1000);
    ov.safety.setRadius(safetyRadiusKm * 1000);
  });
  updateFakeStats(latestAircraft);
}

// 슬라이더는 입력 즉시 반영, 숫자 입력 필드는 change/blur/Enter 에만 반영해 타이핑 중 값이 덮이지 않게 함
["input", "change"].forEach((evt) => {
  radarRadiusInput?.addEventListener(evt, applyManualRanges);
  safetyRadiusInput?.addEventListener(evt, applyManualRanges);

  const handleEta = () => {
    syncEtaRange();
  };
  etaMaxInput?.addEventListener(evt, handleEta);
});

["change", "blur"].forEach((evt) => {
  radarValueEl?.addEventListener(evt, applyManualRanges);
  safetyValueEl?.addEventListener(evt, applyManualRanges);

  const handleEtaField = () => {
    etaMaxInput.value = etaMaxValueEl?.value || etaMaxInput.value;
    syncEtaRange();
  };
  etaMaxValueEl?.addEventListener(evt, handleEtaField);
});

altRangeInput?.addEventListener("input", () => syncAltRange());
altRangeInput?.addEventListener("change", () => syncAltRange());
altRangeValueEl?.addEventListener("change", () => {
  if (altRangeInput) altRangeInput.value = altRangeValueEl.value;
  syncAltRange();
});

// Enter 키로 입력값 즉시 반영
const bindEnterApply = (el, fn) => {
  if (!el || typeof fn !== "function") return;
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      fn();
      e.target.blur();
    }
  });
};

bindEnterApply(radarValueEl, applyManualRanges);
bindEnterApply(safetyValueEl, applyManualRanges);
bindEnterApply(altRangeValueEl, () => {
  if (altRangeInput) altRangeInput.value = altRangeValueEl.value;
  syncAltRange();
});
bindEnterApply(etaMaxValueEl, () => {
  etaMaxInput.value = etaMaxValueEl.value;
  syncEtaRange();
});

applyManualRanges();
syncEtaRange(false);
syncAltRange(false);

// config.json을 읽어 폴링 주기/슬라이더 한도 적용
async function loadConfig() {
  try {
    const res = await fetch("./config.json", { cache: "no-store" });
    if (!res.ok) return;
    const cfg = await res.json();
    if (cfg && Number.isFinite(cfg.pollMs)) {
      pollMs = Math.max(200, Number(cfg.pollMs));
      console.log(`[config] pollMs set to ${pollMs}ms`);
    }
    if (cfg && Number.isFinite(cfg.radarRadiusMaxKm) && radarRadiusInput) {
      radarRadiusInput.max = cfg.radarRadiusMaxKm;
      radarRadiusKm = Math.min(radarRadiusKm, cfg.radarRadiusMaxKm);
    }
    if (cfg && Number.isFinite(cfg.safetyRadiusMaxKm) && safetyRadiusInput) {
      safetyRadiusInput.max = cfg.safetyRadiusMaxKm;
      safetyRadiusKm = Math.min(safetyRadiusKm, cfg.safetyRadiusMaxKm);
    }
    const brightnessCfg = cfg?.mapBrightnessPercent;
    if (Number.isFinite(brightnessCfg)) {
      setMapBrightness(brightnessCfg);
    }
    const etaMaxCfg = cfg?.etaMaxMinutes;
    if (Number.isFinite(etaMaxCfg) && etaMaxInput) {
      etaMaxInput.max = etaMaxCfg;
    }
    applyManualRanges();
    syncEtaRange(false);
  } catch (e) {
    console.warn("config.json load skipped", e);
  }
}

initPwaUi();


// 초기 부팅 + 플로팅 입력폼 드래그 설정
(async () => {
  await loadConfig();
  poll();

  closeFakeForm();

  if (!floatingForm) return;
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  const onDown = (e) => {
    // 폼 내부 입력/버튼 등과 상호작용 중에는 드래그 금지
    const tag = e.target.tagName.toLowerCase();
    if (["input", "button", "label", "select", "textarea"].includes(tag)) return;
    dragging = true;
    floatingForm.classList.add("dragging");
    const rect = floatingForm.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    // 자유롭게 이동하도록 right/bottom 리셋
    floatingForm.style.right = "auto";
    floatingForm.style.bottom = "auto";
  };

  const onMove = (e) => {
    if (!dragging) return;
    const x = e.clientX - offsetX;
    const y = e.clientY - offsetY;
    floatingForm.style.left = `${x}px`;
    floatingForm.style.top = `${y}px`;
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    floatingForm.classList.remove("dragging");
  };

  floatingForm.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
})();
