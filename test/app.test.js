const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const rules = require("../lib/rules");
const weather = require("../lib/weather");
const ai = require("../lib/ai");

const base = { place: "야외", importance: "보통", category: "없음" };
const calm = { tmax: 24, tmin: 14, pop: 20, wind: 2, pmGrade: "보통" };

// ---------- 규칙 ----------
test("폭염 야외: 조정 필요도 45, 실내로 변경", () => {
  const r = rules.decide({ ...base, weather: { ...calm, tmax: 39 } });
  assert.equal(r.score, 45);
  assert.equal(r.verdict, "실내로 변경");
});

test("미세먼지 매우 나쁨 야외는 강행이 아니다", () => {
  const r = rules.decide({ ...base, weather: { ...calm, pmGrade: "매우나쁨" } });
  assert.equal(r.score, 45);
  assert.notEqual(r.verdict, "강행");
});

test("호우 야외: 강수 90% + 풍속 10 = 50, 실내로 변경", () => {
  const r = rules.decide({ ...base, weather: { ...calm, pop: 90, wind: 10 } });
  assert.equal(r.score, 50);
  assert.equal(r.verdict, "실내로 변경");
});

test("귀찮음만으로는 미루기가 나오지 않는다(상한 +5)", () => {
  const r = rules.decide({ ...base, category: "단순 귀찮음", weather: calm });
  assert.equal(r.score, 5);
  assert.equal(r.verdict, "강행");
});

test("폭염 + 가벼운 컨디션 + 호우는 미루기", () => {
  const r = rules.decide({ ...base, category: "가벼운 컨디션", weather: { ...calm, tmax: 36, pop: 90 } });
  assert.equal(r.score, 30 + 40 + 15);
  assert.equal(r.verdict, "미루기");
});

test("개인 사정은 10가지로 나뉘고 점수는 최대 +55", () => {
  assert.equal(rules.AI_CLASSES.length, 10);
  assert.equal(Math.max(...Object.values(rules.REASON_POINTS)), 55);
  assert.equal(rules.REASON_POINTS["가족·응급"], 55);
  assert.equal(rules.REASON_POINTS["단순 귀찮음"], 5);
});

test("날씨가 괜찮을 때 사정 점수만으로: 큰 사정은 미루기, 작은 사정은 강행", () => {
  const verdictOf = (category) => rules.decide({ ...base, category, weather: calm }).verdict;
  for (const c of ["가족·응급", "심한 건강 문제", "시험·마감", "업무·야근", "약속 겹침"]) assert.equal(verdictOf(c), "미루기", c);
  for (const c of ["이동 곤란", "가벼운 컨디션", "감정", "단순 귀찮음", "기타", "없음"]) assert.equal(verdictOf(c), "강행", c);
});

test("사정이 주된 이유면 장소를 바꾸지 않고 미루기, 날씨가 주된 이유면 실내로 변경", () => {
  const a = rules.decide({ ...base, category: "업무·야근", weather: { ...calm, pop: 60 } }); // 25 + 40 = 65
  assert.equal(a.score, 65);
  assert.equal(a.verdict, "미루기");
  const b = rules.decide({ ...base, category: "감정", weather: { ...calm, tmax: 39 } }); // 45 + 15 = 60
  assert.equal(b.score, 60);
  assert.equal(b.verdict, "실내로 변경");
});

test("중요한 약속이어도 개인 사정 점수는 깎지 않는다", () => {
  const r = rules.decide({ ...base, importance: "중요", category: "심한 건강 문제", weather: { ...calm, pop: 0 } });
  assert.equal(r.score, 50);
  assert.equal(r.verdict, "미루기");
});

test("단독 악천후: 강수확률 90%·풍속 20m/s는 강행이 아니다", () => {
  assert.notEqual(rules.decide({ ...base, weather: { ...calm, pop: 90 } }).verdict, "강행");
  const w = rules.decide({ ...base, weather: { ...calm, wind: 20 } });
  assert.equal(w.score, 45);
  assert.notEqual(w.verdict, "강행");
});

test("초미세먼지 나쁨은 +15", () => {
  assert.equal(rules.decide({ ...base, weather: { ...calm, pmGrade: "나쁨" } }).score, 15);
});

test("실내 약속은 날씨 40%만 반영하고 '실내로 변경'이 나오지 않는다", () => {
  const r = rules.decide({ ...base, place: "실내", weather: { ...calm, tmax: 39, pop: 90 } });
  assert.equal(r.parts.weather, Math.round((45 + 40) * 0.4));
  assert.notEqual(r.verdict, "실내로 변경");
});

test("중요한 약속은 불편한 날씨만 최대 15점 낮추고 위험한 날씨는 낮추지 않는다", () => {
  const mild = rules.decide({ ...base, importance: "중요", weather: { ...calm, pop: 60 } }); // 날씨 25 → 10
  assert.equal(mild.score, 10);
  assert.equal(mild.verdict, "강행");
  const danger = rules.decide({ ...base, importance: "중요", weather: { ...calm, tmax: 39 } });
  assert.equal(danger.score, 45);
  assert.equal(danger.verdict, "실내로 변경");
});

test("값이 없으면 반영하지 못했다고 알린다", () => {
  const r = rules.decide({ ...base, weather: { tmax: null, tmin: null, pop: null, wind: null, pmGrade: null } });
  assert.deepEqual(r.missing.sort(), ["강수확률", "미세먼지 예보", "최고기온", "풍속"].sort());
  assert.equal(r.score, 0);
});

test("초미세먼지 등급 경계값", () => {
  assert.equal(rules.pmGradeFromValue(15), "좋음");
  assert.equal(rules.pmGradeFromValue(16), "보통");
  assert.equal(rules.pmGradeFromValue(35), "보통");
  assert.equal(rules.pmGradeFromValue(36), "나쁨");
  assert.equal(rules.pmGradeFromValue(75), "나쁨");
  assert.equal(rules.pmGradeFromValue(76), "매우나쁨");
  assert.equal(rules.pmGradeFromValue(null), null);
});

test("사정 분류(규칙)", () => {
  assert.equal(rules.classifyByRule("").type, "없음");
  assert.equal(rules.classifyByRule("오늘 나가기 너무 귀찮아").type, "단순 귀찮음");
  assert.equal(rules.classifyByRule("갑자기 야근이 생겼어").type, "업무·야근");
  assert.equal(rules.classifyByRule("몸살 기운이 있어").type, "가벼운 컨디션");
  assert.equal(rules.classifyByRule("장례식 때문에 못 가").type, "가족·응급");
  assert.equal(rules.classifyByRule("고열이 나서 병원 가야 해").type, "심한 건강 문제");
  assert.equal(rules.classifyByRule("내일 시험이야").type, "시험·마감");
  assert.equal(rules.classifyByRule("지하철 파업이래").type, "이동 곤란");
  assert.equal(rules.classifyByRule("다른 약속이 또 있어").type, "약속 겹침");
  assert.equal(rules.classifyByRule("스트레스 받아서").type, "감정");
  assert.equal(rules.classifyByRule("오늘 기분 좋아").type, "기타");
  assert.equal(rules.classifyByRule("요즘 계속 무기력해").type, "안부");
});

// ---------- 기상청·에어코리아 ----------
test("pickBase: 발표 10분 뒤부터 새 base_time", () => {
  // 2026-10-21 14:15 KST = 05:15 UTC
  assert.deepEqual(weather.pickBase(new Date("2026-10-21T05:15:00Z")), { baseDate: "20261021", baseTime: "1400" });
  // 14:05 KST는 아직 1100
  assert.deepEqual(weather.pickBase(new Date("2026-10-21T05:05:00Z")), { baseDate: "20261021", baseTime: "1100" });
  // 02:05 KST는 전날 2300
  assert.deepEqual(weather.pickBase(new Date("2026-10-20T17:05:00Z")), { baseDate: "20261020", baseTime: "2300" });
});

test("서비스키가 인코딩 형태여도 한 번만 인코딩된다", () => {
  assert.equal(weather.normKey("abc%2Bdef%3D%3D"), "abc+def==");
  assert.equal(weather.normKey("abc+def=="), "abc+def==");
});

const items = [
  { fcstDate: "20261021", fcstTime: "1400", category: "TMP", fcstValue: "30" },
  { fcstDate: "20261021", fcstTime: "1500", category: "TMP", fcstValue: "31" },
  { fcstDate: "20261021", fcstTime: "0600", category: "TMP", fcstValue: "18" },
  { fcstDate: "20261021", fcstTime: "1500", category: "TMX", fcstValue: "31.0" },
  { fcstDate: "20261021", fcstTime: "0600", category: "TMN", fcstValue: "17.0" },
  { fcstDate: "20261021", fcstTime: "1500", category: "POP", fcstValue: "60" },
  { fcstDate: "20261021", fcstTime: "1400", category: "POP", fcstValue: "40" },
  { fcstDate: "20261021", fcstTime: "1500", category: "WSD", fcstValue: "4.5" },
  { fcstDate: "20261022", fcstTime: "1500", category: "TMP", fcstValue: "10" },
];

test("기상청 응답 요약: 약속 시각에 가장 가까운 값과 하루 최고·최저", () => {
  const s = weather.summarizeKma(items, "20261021", 15);
  assert.deepEqual(s, { tmax: 31, tmin: 17, pop: 60, wind: 4.5 });
  const s2 = weather.summarizeKma(items, "20261021", 13);
  assert.equal(s2.pop, 40); // 13시에는 14시 값이 가장 가깝다
  assert.equal(weather.summarizeKma(items, "20261030", 15), null);
});

test("에어코리아 등급 문자열 파싱", () => {
  const g = "서울 : 좋음,제주 : 보통,경기북부 : 나쁨,세종 : 매우나쁨";
  assert.equal(weather.parseGrade(g, "서울"), "좋음");
  assert.equal(weather.parseGrade(g, "세종"), "매우나쁨");
  assert.equal(weather.parseGrade(g, "부산"), null);
});

test("fetchKma: 쪽수를 넘기며 모두 읽는다(모의 응답)", async () => {
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async (url) => {
    calls++;
    const page = Number(new URL(url).searchParams.get("pageNo"));
    const item = page === 1 ? items.slice(0, 5) : items.slice(5);
    return { ok: true, text: async () => JSON.stringify({ response: { header: { resultCode: "00" }, body: { totalCount: items.length, items: { item } } } }) };
  };
  try {
    const r = await weather.fetchKma({ key: "k", region: "서울", dateYmd: "20261021", hour: 15, now: new Date("2026-10-21T05:15:00Z") });
    assert.equal(calls, 2);
    assert.equal(r.weather.pop, 60);
    assert.equal(r.baseTime, "1400");
  } finally { global.fetch = realFetch; }
});

// ---------- AI 검증 ----------
test("AI가 규칙에 없는 숫자를 쓰면 버린다", () => {
  const allowed = '최고기온 39℃로 폭염중대경보 기준 수준입니다 4월 5일 15시 45';
  const good = { messages: { polite: "최고기온 39℃라 걱정돼요.", light: "39℃래!", firm: "39℃라서 어렵습니다." } };
  const bad = { messages: { polite: "최고기온 42℃라 걱정돼요.", light: "x", firm: "y" } };
  assert.ok(ai.validateAi(good, allowed));
  assert.equal(ai.validateAi(bad, allowed), null);
  assert.equal(ai.validateAi({ messages: { polite: "", light: "a", firm: "b" } }, allowed), null);
});

test("AI 응답이 검증을 통과하면 AI 문장을 쓰고, 실패하면 규칙 문장을 쓴다(모의)", async () => {
  const realFetch = global.fetch;
  process.env.GEMINI_API_KEY = "test";
  const ctx = { verdict: "실내로 변경", score: 45, relation: "친구", whenLabel: "10월 21일 15시", place: "야외",
    reasons: ["최고기온 39℃로 폭염중대경보 기준 수준입니다"], category: "없음" };
  const reply = (obj) => async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }) });
  try {
    global.fetch = reply({ messages: { polite: "39℃라 실내가 어떨까요?", light: "39℃래, 실내 가자", firm: "39℃라 실내로 바꾸자" } });
    const ok = await ai.writeWithAi(ctx);
    assert.equal(ok.used, "ai");
    global.fetch = reply({ messages: { polite: "52℃라 위험해요", light: "a", firm: "b" } });
    const no = await ai.writeWithAi(ctx);
    assert.equal(no.used, "rule");
    assert.equal(no.messages.length, 3);
  } finally { global.fetch = realFetch; delete process.env.GEMINI_API_KEY; }
});

test("사정 분류: AI가 허용 밖 값을 주면 규칙 분류를 쓴다(모의)", async () => {
  const realFetch = global.fetch;
  process.env.GEMINI_API_KEY = "test";
  try {
    global.fetch = async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"category":"해킹"}' }] } }] }) });
    const r = await ai.classifyWithAi("아무 말", "기타");
    assert.deepEqual(r, { category: "기타", used: "rule" });
    global.fetch = async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"category":"심한 건강 문제"}' }] } }] }) });
    assert.deepEqual(await ai.classifyWithAi("몸이 안 좋아", "기타"), { category: "심한 건강 문제", used: "ai" });
  } finally { global.fetch = realFetch; delete process.env.GEMINI_API_KEY; }
});

// ---------- API ----------
function call(handler, body) {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, async () => {
      const { port } = server.address();
      const r = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      server.close();
      resolve({ status: r.status, j });
    });
  });
}

function todayKst() { return weather.ymdDash(weather.kst(new Date())); }
function plusKst(n) { return weather.ymdDash(weather.addDays(weather.kst(new Date()), n)); }

test("API: 키 없이 시험 데이터로 판결하고 시험 데이터라고 표시한다", async () => {
  delete process.env.DATA_GO_KR_KEY; delete process.env.GEMINI_API_KEY;
  const handler = require("../api/verdict");
  const { status, j } = await call(handler, { region: "서울", date: todayKst(), hour: 15, place: "야외", importance: "보통", relation: "친구", reason: "" });
  assert.equal(status, 200);
  assert.equal(j.meta.source, "시험 데이터");
  assert.equal(j.verdict, "강행");
  assert.equal(j.messages.length, 3);
  assert.equal(j.meta.messagesBy, "rule");
});

test("API: 직접 입력(폭염)은 실내로 변경, 대표 입력과 같은 결과", async () => {
  const handler = require("../api/verdict");
  const { j } = await call(handler, { region: "서울", date: todayKst(), hour: 15, place: "야외", importance: "보통", relation: "친구", reason: "",
    manual: { tmax: 39, tmin: 27, pop: 0, wind: 2, pmGrade: "보통" } });
  assert.equal(j.score, 45);
  assert.equal(j.verdict, "실내로 변경");
  assert.equal(j.meta.source, "직접 입력(시험용)");
});

test("API: 안부 표현은 판결 대신 안부 문구만 돌려준다", async () => {
  const handler = require("../api/verdict");
  const { status, j } = await call(handler, { region: "서울", date: todayKst(), hour: 15, place: "야외", importance: "보통", relation: "친구", reason: "요즘 너무 무기력해" });
  assert.equal(status, 200);
  assert.ok(j.care);
  assert.equal(j.verdict, undefined);
});

test("API: 범위 밖 날짜·지역·시각은 거절", async () => {
  const handler = require("../api/verdict");
  const ok = { region: "서울", date: todayKst(), hour: 15, place: "야외", importance: "보통", relation: "친구", reason: "" };
  assert.equal((await call(handler, { ...ok, date: plusKst(4) })).status, 400);
  assert.equal((await call(handler, { ...ok, date: plusKst(-1) })).status, 400);
  assert.equal((await call(handler, { ...ok, region: "뉴욕" })).status, 400);
  assert.equal((await call(handler, { ...ok, hour: 25 })).status, 400);
  assert.equal((await call(handler, { ...ok, place: "해변" })).status, 400);
});
