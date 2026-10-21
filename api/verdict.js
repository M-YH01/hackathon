// POST /api/verdict : 입력을 검증하고, 공공데이터(또는 시험 데이터)로 판결을 만든다.
const { REGIONS, kst, ymd, ymdDash, addDays, fetchKma, fetchAir } = require("../lib/weather");
const { decide, classifyByRule, pmGradeFromValue } = require("../lib/rules");
const { classifyWithAi, writeWithAi } = require("../lib/ai");

const PLACES = ["야외", "실내"];
const IMPORTANCE = ["가벼움", "보통", "중요"];
const RELATIONS = ["친구", "동료", "상사"];
const MAX_DAYS_AHEAD = 3; // 오늘~글피. 4일째부터는 강수량·풍속이 정성 코드라 제외한다.

function bad(res, code, message) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: message }));
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 20000) reject(new Error("too large")); });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

function numOrNull(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 시험 데이터(키가 없을 때): 공공데이터가 아니라는 점을 화면에 표시한다.
// 같은 서버 인스턴스가 살아 있는 동안만 유지되는 임시 저장(에어코리아 지연 대비). 파일·DB에 저장하지 않는다.
const AIR_CACHE = new Map();

const FIXTURE_WEATHER = { tmax: 29, tmin: 19, pop: 20, wind: 2 };

async function handler(req, res) {
  if (req.method !== "POST") return bad(res, 405, "POST만 지원합니다");
  let body;
  try { body = await readBody(req); } catch { return bad(res, 400, "요청을 읽지 못했습니다"); }

  const region = body.region;
  const place = body.place;
  const importance = body.importance;
  const relation = body.relation;
  const hour = Number(body.hour);
  const dateStr = String(body.date || "");
  const userText = String(body.reason || "").trim().slice(0, 100);
  if (!REGIONS[region]) return bad(res, 400, "지원하지 않는 지역입니다");
  if (!PLACES.includes(place) || !IMPORTANCE.includes(importance) || !RELATIONS.includes(relation)) {
    return bad(res, 400, "입력값이 올바르지 않습니다");
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return bad(res, 400, "시각이 올바르지 않습니다");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return bad(res, 400, "날짜가 올바르지 않습니다");

  const now = new Date();
  const today = kst(now);
  const first = ymdDash(today);
  const last = ymdDash(addDays(today, MAX_DAYS_AHEAD));
  if (dateStr < first || dateStr > last) {
    return bad(res, 400, `날짜는 ${first}부터 ${last}까지 고를 수 있습니다(오늘~글피)`);
  }
  const dateYmd = dateStr.replace(/-/g, "");
  const whenLabel = `${Number(dateStr.slice(5, 7))}월 ${Number(dateStr.slice(8, 10))}일 ${hour}시`;

  // 1) 개인 사정 분류: 안부 표현은 규칙이 먼저 걸러내며 AI로 보내지 않는다.
  const rule = classifyByRule(userText);
  if (rule.type === "안부") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({
      care: "요즘 많이 힘드신 것 같아 걱정돼요. 판결보다 먼저, 가까운 사람이나 전문 상담에 마음을 나눠 보세요.",
    }));
  }
  let category = rule.type;
  let classifiedBy = "rule";
  if (userText && process.env.GEMINI_API_KEY) {
    const c = await classifyWithAi(userText, rule.type);
    category = c.category;
    classifiedBy = c.used;
  }

  // 2) 날씨·대기질: 직접 입력(시험) > 공공데이터 > 시험 데이터
  const meta = { source: null, notes: [] };
  let weather;
  const manual = body.manual && typeof body.manual === "object" ? body.manual : null;
  const key = process.env.DATA_GO_KR_KEY;
  if (manual) {
    const pmGrade = ["좋음", "보통", "나쁨", "매우나쁨"].includes(manual.pmGrade)
      ? manual.pmGrade : pmGradeFromValue(numOrNull(manual.pm));
    weather = {
      tmax: numOrNull(manual.tmax), tmin: numOrNull(manual.tmin),
      pop: numOrNull(manual.pop), wind: numOrNull(manual.wind), pmGrade,
    };
    meta.source = "직접 입력(시험용)";
  } else if (key && process.env.USE_FIXTURES !== "1") {
    try {
      // 기상청과 에어코리아를 동시에 부른다. 에어코리아는 응답이 느릴 때가 있어 15초까지 기다린다.
      // 실패하면(시간 초과 포함) 같은 지역·날짜로 최근 6시간 안에 성공한 값을 대신 쓰고 화면에 알린다.
      const airTask = (async () => {
        const ck = `${region}|${dateStr}`;
        let last = null;
        for (let i = 0; i < 2; i++) {
          try {
            const a = await fetchAir({ key, region, dateDash: dateStr, now, timeoutMs: 15000 });
            if (a.pmGrade) AIR_CACHE.set(ck, { air: a, at: Date.now() });
            return a;
          } catch (e) {
            last = e;
            if (e && e.name === "AbortError") break; // 시간 초과는 다시 시도해도 오래 걸리므로 바로 대체한다
          }
        }
        const hit = AIR_CACHE.get(ck);
        if (hit && Date.now() - hit.at < 6 * 3600 * 1000) {
          return { ...hit.air, note: "에어코리아 호출이 지연되어 직전에 조회한 미세먼지 예보 값을 사용했습니다" };
        }
        const reason = last && last.name === "AbortError" ? "응답 시간 초과" : (last && last.message) || "알 수 없는 오류";
        return { pmGrade: null, note: `에어코리아 예보를 불러오지 못했습니다(${reason})` };
      })();
      const k = await fetchKma({ key, region, dateYmd, hour, now });
      const air = await airTask;
      weather = { ...k.weather, pmGrade: air.pmGrade };
      meta.source = "공공데이터";
      meta.kma = `기상청 단기예보 base_date ${k.baseDate}, base_time ${k.baseTime}`;
      meta.air = air.dataTime ? `에어코리아 대기질 예보통보 ${air.dataTime}` : null;
      if (air.note) meta.notes.push(air.note);
    } catch (e) {
      return bad(res, 502, `공공데이터를 불러오지 못했습니다: ${e.message}`);
    }
  } else {
    weather = { ...FIXTURE_WEATHER, pmGrade: "보통" };
    meta.source = "시험 데이터";
    meta.notes.push("API 키가 없어 고정된 시험 값을 사용했습니다. 공공데이터가 아닙니다.");
  }

  // 3) 규칙으로 판결
  const result = decide({ weather, place, importance, category });
  if (result.missing.length) meta.notes.push(`다음 값은 예보가 없어 반영하지 못했습니다: ${result.missing.join(", ")}`);

  // 4) 메시지 3종: AI(검증 통과 시) 또는 규칙 문장
  const written = await writeWithAi({
    verdict: result.verdict, score: result.score, relation, whenLabel, place,
    reasons: result.reasons, category,
  });

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({
    verdict: result.verdict,
    score: result.score,
    parts: result.parts,
    reasons: result.reasons,
    category,
    messages: written.messages,
    weather,
    meta: {
      ...meta,
      classifiedBy,
      messagesBy: written.used,
      model: written.model,
      region, whenLabel,
    },
  }));
}

module.exports = handler;
module.exports.default = handler;
