// 기상청 단기예보(getVilageFcst)와 에어코리아 대기질 예보통보(getMinuDustFrcstDspth) 호출.
// 키가 없으면 호출하지 않고 시험 데이터를 돌려준다. 시험 데이터는 화면에 "시험 데이터"로 표시된다.

const KMA_URL = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst";
const AIR_URL = "https://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getMinuDustFrcstDspth";

// 위경도 → 기상청 격자(nx, ny). 기상청 단기예보 활용가이드의 Lambert 정각원추도법 변환식을 그대로 쓴다.
function latLonToGrid(lat, lon) {
  const RE = 6371.00877, GRID = 5.0, SLAT1 = 30.0, SLAT2 = 60.0, OLON = 126.0, OLAT = 38.0, XO = 43, YO = 136;
  const D = Math.PI / 180.0;
  const re = RE / GRID;
  const slat1 = SLAT1 * D, slat2 = SLAT2 * D, olon = OLON * D, olat = OLAT * D;
  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = (Math.pow(sf, sn) * Math.cos(slat1)) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = (re * sf) / Math.pow(ro, sn);
  let ra = Math.tan(Math.PI * 0.25 + lat * D * 0.5);
  ra = (re * sf) / Math.pow(ra, sn);
  let theta = lon * D - olon;
  if (theta > Math.PI) theta -= 2.0 * Math.PI;
  if (theta < -Math.PI) theta += 2.0 * Math.PI;
  theta *= sn;
  return {
    nx: Math.floor(ra * Math.sin(theta) + XO + 0.5),
    ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5),
  };
}

// 지역: 시청·도청 소재지 위경도와, 에어코리아 예보통보에서 그 지역을 가리키는 이름(air)
const REGION_SEED = {
  "서울": { lat: 37.5665, lon: 126.9780, air: ["서울"] },
  "부산": { lat: 35.1796, lon: 129.0756, air: ["부산"] },
  "대구": { lat: 35.8714, lon: 128.6014, air: ["대구"] },
  "인천": { lat: 37.4563, lon: 126.7052, air: ["인천"] },
  "광주": { lat: 35.1595, lon: 126.8526, air: ["광주"] },
  "대전": { lat: 36.3504, lon: 127.3845, air: ["대전"] },
  "울산": { lat: 35.5384, lon: 129.3114, air: ["울산"] },
  "세종": { lat: 36.4800, lon: 127.2890, air: ["세종"] },
  "수원": { lat: 37.2636, lon: 127.0286, air: ["경기남부"] },
  "의정부": { lat: 37.7381, lon: 127.0337, air: ["경기북부"] },
  "춘천": { lat: 37.8813, lon: 127.7298, air: ["영서", "강원영서"] },
  "강릉": { lat: 37.7519, lon: 128.8761, air: ["영동", "강원영동"] },
  "청주": { lat: 36.6424, lon: 127.4890, air: ["충북"] },
  "천안": { lat: 36.8151, lon: 127.1139, air: ["충남"] },
  "전주": { lat: 35.8242, lon: 127.1480, air: ["전북"] },
  "목포": { lat: 34.8118, lon: 126.3922, air: ["전남"] },
  "포항": { lat: 36.0190, lon: 129.3435, air: ["경북"] },
  "창원": { lat: 35.2280, lon: 128.6811, air: ["경남"] },
  "제주": { lat: 33.4996, lon: 126.5312, air: ["제주"] },
};
const REGIONS = {};
for (const [name, r] of Object.entries(REGION_SEED)) REGIONS[name] = { ...r, ...latLonToGrid(r.lat, r.lon) };

const BASE_TIMES = [200, 500, 800, 1100, 1400, 1700, 2000, 2300];

const pad = (n, w = 2) => String(n).padStart(w, "0");

// 한국 시간(UTC+9)으로 옮긴 날짜의 UTC getter를 쓴다.
function kst(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000);
}
function ymd(d) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}
function ymdDash(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function addDays(d, n) {
  return new Date(d.getTime() + n * 86400000);
}

// 발표 후 10분이 지난 가장 최근 base_date/base_time
function pickBase(now = new Date()) {
  const k = kst(now);
  const minutes = k.getUTCHours() * 60 + k.getUTCMinutes();
  let best = null;
  for (const bt of BASE_TIMES) {
    const m = Math.floor(bt / 100) * 60 + (bt % 100);
    if (minutes >= m + 10) best = bt;
  }
  if (best === null) return { baseDate: ymd(addDays(k, -1)), baseTime: "2300" };
  return { baseDate: ymd(k), baseTime: pad(best, 4) };
}

// 서비스키가 인코딩된 형태(%2B 등)로 들어와도 한 번만 인코딩되게 맞춘다.
function normKey(key) {
  if (!key) return key;
  return key.includes("%") ? decodeURIComponent(key) : key;
}

async function getJson(url, params, timeoutMs = 10000) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(u, { signal: ctl.signal });
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch {
      // 공공데이터포털은 오류를 XML로 돌려줄 때가 있다.
      const m = text.match(/<returnAuthMsg>(.*?)<\/returnAuthMsg>/) || text.match(/<errMsg>(.*?)<\/errMsg>/);
      throw new Error(`공공데이터 응답을 읽지 못했습니다${m ? ": " + m[1] : ""}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// 기상청 응답 items → 약속 날짜·시각에 맞는 값 {tmax, tmin, pop, wind, pty, pcp, sno}
function summarizeKma(items, dateYmd, hour) {
  const day = items.filter((i) => i.fcstDate === dateYmd);
  if (!day.length) return null;
  const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  const byCat = (cat) => day.filter((i) => i.category === cat);
  const nearestItem = (cat) => {
    const list = byCat(cat);
    if (!list.length) return null;
    let best = list[0];
    let bd = Infinity;
    for (const i of list) {
      const d = Math.abs(parseInt(i.fcstTime.slice(0, 2), 10) - hour);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  const nearest = (cat) => { const b = nearestItem(cat); return b ? num(b.fcstValue) : null; };
  const nearestRaw = (cat) => { const b = nearestItem(cat); return b ? b.fcstValue : null; };
  const tmps = byCat("TMP").map((i) => num(i.fcstValue)).filter((n) => n !== null);
  const tmxList = byCat("TMX").map((i) => num(i.fcstValue)).filter((n) => n !== null);
  const tmnList = byCat("TMN").map((i) => num(i.fcstValue)).filter((n) => n !== null);
  const tmax = tmxList.length ? tmxList[0] : tmps.length ? Math.max(...tmps) : null;
  const tmin = tmnList.length ? tmnList[0] : tmps.length ? Math.min(...tmps) : null;
  const ptyRaw = nearestRaw("PTY");
  return {
    tmax, tmin, pop: nearest("POP"), wind: nearest("WSD"),
    pty: ptyRaw === null ? null : parseInt(ptyRaw, 10),
    pcp: parseAmount(nearestRaw("PCP"), "mm"),
    sno: parseAmount(nearestRaw("SNO"), "cm"),
  };
}

// 강수량(PCP)·적설(SNO)은 숫자가 아니라 "강수없음", "1mm 미만", "1.0mm", "30.0~50.0mm", "50.0mm 이상"처럼 온다.
// 범위는 아래쪽 값, "미만"은 0으로, "이상"은 그 값으로 읽는다(과장하지 않기 위해 낮게 잡는다).
function parseAmount(raw, unit) {
  if (raw === null || raw === undefined) return null;
  const t = String(raw).trim();
  if (!t || /없음/.test(t)) return 0;
  if (/미만/.test(t)) return 0;
  const m = t.match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

async function fetchKma({ key, region, dateYmd, hour, now }) {
  const { nx, ny } = REGIONS[region];
  const { baseDate, baseTime } = pickBase(now);
  const items = [];
  let page = 1;
  for (;;) {
    const json = await getJson(KMA_URL, {
      serviceKey: normKey(key), pageNo: page, numOfRows: 1000, dataType: "JSON",
      base_date: baseDate, base_time: baseTime, nx, ny,
    });
    const body = json && json.response && json.response.body;
    const header = json && json.response && json.response.header;
    if (!body) {
      throw new Error(`기상청 응답 오류${header ? `: ${header.resultMsg}` : ""}`);
    }
    const got = (body.items && body.items.item) || [];
    items.push(...got);
    if (items.length >= (body.totalCount || 0) || !got.length || page >= 5) break;
    page++;
  }
  const w = summarizeKma(items, dateYmd, hour);
  if (!w) throw new Error("선택한 날짜의 기상청 예보가 없습니다(예보 범위 밖일 수 있습니다)");
  return { weather: w, baseDate, baseTime };
}

// "서울 : 좋음,제주 : 보통,..." → 지역 등급
function parseGrade(informGrade, region) {
  if (!informGrade) return null;
  const names = REGIONS[region] ? REGIONS[region].air.concat(region) : [region];
  for (const part of informGrade.split(",")) {
    const [name, grade] = part.split(":").map((s) => s.trim());
    if (names.includes(name) && grade) return grade;
  }
  return null;
}

async function fetchAir({ key, region, dateDash, now, timeoutMs = 10000 }) {
  const today = ymdDash(kst(now));
  const json = await getJson(AIR_URL, {
    serviceKey: normKey(key), returnType: "json", numOfRows: 100, pageNo: 1,
    searchDate: today, InformCode: "PM25", informCode: "PM25",
  }, timeoutMs);
  const body = json && json.response && json.response.body;
  if (!body) throw new Error("에어코리아 응답 오류");
  const items = (body.items || []).filter((i) => i.informData === dateDash && i.informCode === "PM25");
  if (!items.length) return { pmGrade: null, note: "해당 날짜의 미세먼지 예보가 아직 없습니다" };
  items.sort((a, b) => String(b.dataTime).localeCompare(String(a.dataTime)));
  const grade = parseGrade(items[0].informGrade, region);
  return { pmGrade: grade, note: grade ? null : "해당 지역의 미세먼지 등급을 찾지 못했습니다", dataTime: items[0].dataTime };
}

module.exports = {
  REGIONS, latLonToGrid, kst, ymd, ymdDash, addDays, pickBase, normKey,
  summarizeKma, parseGrade, fetchKma, fetchAir,
};
