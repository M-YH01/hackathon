// 기상청 단기예보(getVilageFcst)와 에어코리아 대기질 예보통보(getMinuDustFrcstDspth) 호출.
// 키가 없으면 호출하지 않고 시험 데이터를 돌려준다. 시험 데이터는 화면에 "시험 데이터"로 표시된다.

const KMA_URL = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst";
const AIR_URL = "https://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getMinuDustFrcstDspth";

// 기상청 격자(nx, ny) 대표값. 다른 지역은 단기예보 활용가이드의 격자 엑셀에서 찾아 추가한다.
const REGIONS = {
  "서울": { nx: 60, ny: 127 },
  "부산": { nx: 98, ny: 76 },
  "대구": { nx: 89, ny: 90 },
  "인천": { nx: 55, ny: 124 },
  "광주": { nx: 58, ny: 74 },
  "대전": { nx: 67, ny: 100 },
  "울산": { nx: 102, ny: 84 },
  "세종": { nx: 66, ny: 103 },
  "제주": { nx: 52, ny: 38 },
};

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

// 기상청 응답 items → 약속 날짜·시각에 맞는 값 {tmax, tmin, pop, wind}
function summarizeKma(items, dateYmd, hour) {
  const day = items.filter((i) => i.fcstDate === dateYmd);
  if (!day.length) return null;
  const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  const byCat = (cat) => day.filter((i) => i.category === cat);
  const nearest = (cat) => {
    const list = byCat(cat);
    if (!list.length) return null;
    let best = list[0];
    let bd = Infinity;
    for (const i of list) {
      const d = Math.abs(parseInt(i.fcstTime.slice(0, 2), 10) - hour);
      if (d < bd) { bd = d; best = i; }
    }
    return num(best.fcstValue);
  };
  const tmps = byCat("TMP").map((i) => num(i.fcstValue)).filter((n) => n !== null);
  const tmxList = byCat("TMX").map((i) => num(i.fcstValue)).filter((n) => n !== null);
  const tmnList = byCat("TMN").map((i) => num(i.fcstValue)).filter((n) => n !== null);
  const tmax = tmxList.length ? tmxList[0] : tmps.length ? Math.max(...tmps) : null;
  const tmin = tmnList.length ? tmnList[0] : tmps.length ? Math.min(...tmps) : null;
  return { tmax, tmin, pop: nearest("POP"), wind: nearest("WSD") };
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
  for (const part of informGrade.split(",")) {
    const [name, grade] = part.split(":").map((s) => s.trim());
    if (name === region && grade) return grade;
  }
  return null;
}

async function fetchAir({ key, region, dateDash, now }) {
  const today = ymdDash(kst(now));
  const json = await getJson(AIR_URL, {
    serviceKey: normKey(key), returnType: "json", numOfRows: 100, pageNo: 1,
    searchDate: today, InformCode: "PM25", informCode: "PM25",
  });
  const body = json && json.response && json.response.body;
  if (!body) throw new Error("에어코리아 응답 오류");
  const items = (body.items || []).filter((i) => i.informData === dateDash && i.informCode === "PM25");
  if (!items.length) return { pmGrade: null, note: "해당 날짜의 미세먼지 예보가 아직 없습니다" };
  items.sort((a, b) => String(b.dataTime).localeCompare(String(a.dataTime)));
  const grade = parseGrade(items[0].informGrade, region);
  return { pmGrade: grade, note: grade ? null : "해당 지역의 미세먼지 등급을 찾지 못했습니다", dataTime: items[0].dataTime };
}

module.exports = {
  REGIONS, kst, ymd, ymdDash, addDays, pickBase, normKey,
  summarizeKma, parseGrade, fetchKma, fetchAir,
};
