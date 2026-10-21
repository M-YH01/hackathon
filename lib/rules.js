// 규칙 기반 판단: 날씨·대기질·개인 사정으로 "조정 필요도(0~100)"를 계산한다.
// AI는 이 점수를 바꾸지 않는다. AI가 하는 일은 사정 분류와 메시지 작성이다.

const PM_POINTS = { "좋음": 0, "보통": 0, "나쁨": 15, "매우나쁨": 45 };

// 개인 사정별 점수(조정 필요도에 더해진다). 사정이 클수록 점수도 크지만 최대 +55로 묶는다.
// 분류가 다르면 점수도 달라야 하므로 사정을 10가지로 나눈다.
// 단순 귀찮음은 +5라서 날씨가 괜찮은 날에는 어떤 경우에도 미루기가 나오지 않는다.
const REASON_POINTS = {
  "없음": 0,
  "가족·응급": 55,       // 경조사, 돌봄, 응급 상황
  "심한 건강 문제": 50,  // 고열, 병원, 부상 등
  "시험·마감": 45,       // 시험, 마감, 발표, 면접
  "업무·야근": 40,       // 갑작스러운 업무, 야근, 회의
  "약속 겹침": 40,       // 다른 약속과 시간이 겹침
  "이동 곤란": 30,       // 교통 파업, 차량 고장 등
  "가벼운 컨디션": 15,   // 피곤함, 졸림, 약한 몸살
  "감정": 15,            // 스트레스, 기분 문제
  "단순 귀찮음": 5,
  "기타": 0,
  "안부": 0,
};

const CATEGORIES = Object.keys(REASON_POINTS);
// AI가 고를 수 있는 분류(없음·안부는 규칙이 정한다)
const AI_CLASSES = CATEGORIES.filter((c) => c !== "없음" && c !== "안부");

// 초미세먼지(PM2.5) 일평균 등급 기준(㎍/㎥): 좋음 0~15, 보통 16~35, 나쁨 36~75, 매우나쁨 76 이상
function pmGradeFromValue(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return null;
  const n = Number(v);
  if (n <= 15) return "좋음";
  if (n <= 35) return "보통";
  if (n <= 75) return "나쁨";
  return "매우나쁨";
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// w: { tmax, tmin, pop, wind, pmGrade } (없는 값은 null)
function weatherScore(w, outdoor) {
  let s = 0;
  const reasons = [];
  const missing = [];

  if (isNum(w.tmax)) {
    if (w.tmax >= 39) { s += 45; reasons.push(`최고기온 ${w.tmax}℃로 폭염중대경보 기준 수준입니다`); }
    else if (w.tmax >= 35) { s += 30; reasons.push(`최고기온 ${w.tmax}℃로 폭염 수준입니다`); }
    else if (w.tmax >= 33) { s += 15; reasons.push(`최고기온 ${w.tmax}℃로 매우 덥습니다`); }
  } else missing.push("최고기온");

  if (isNum(w.tmin)) {
    if (w.tmin <= -15) { s += 40; reasons.push(`최저기온 ${w.tmin}℃로 매우 춥습니다`); }
    else if (w.tmin <= -12) { s += 30; reasons.push(`최저기온 ${w.tmin}℃로 많이 춥습니다`); }
    else if (w.tmin <= -8) { s += 15; reasons.push(`최저기온 ${w.tmin}℃로 춥습니다`); }
  }

  if (isNum(w.pop)) {
    if (w.pop >= 80) { s += 40; reasons.push(`강수확률이 ${w.pop}%입니다`); }
    else if (w.pop >= 60) { s += 25; reasons.push(`강수확률이 ${w.pop}%입니다`); }
    else if (w.pop >= 40) { s += 10; reasons.push(`강수확률이 ${w.pop}%입니다`); }
  } else missing.push("강수확률");

  if (isNum(w.wind)) {
    if (w.wind >= 20) { s += 45; reasons.push(`풍속이 ${w.wind}m/s로 위험할 정도로 강합니다`); }
    else if (w.wind >= 14) { s += 30; reasons.push(`풍속이 ${w.wind}m/s로 매우 강합니다`); }
    else if (w.wind >= 9) { s += 10; reasons.push(`풍속이 ${w.wind}m/s로 강한 편입니다`); }
  } else missing.push("풍속");

  if (w.pmGrade && PM_POINTS[w.pmGrade] !== undefined) {
    const p = PM_POINTS[w.pmGrade];
    if (p > 0) { s += p; reasons.push(`초미세먼지 예보가 "${w.pmGrade}"입니다`); }
  } else missing.push("미세먼지 예보");

  if (!outdoor && s > 0) s = Math.round(s * 0.4);
  return { score: s, reasons, missing };
}

// 안부 표현은 점수·AI 호출 전에 먼저 걸러낸다(AI로 보내지 않는다).
const CARE_RE = /우울|무기력|죽고|죽고 ?싶|살기 ?싫|사라지고/;

function classifyByRule(text) {
  const t = (text || "").trim();
  if (!t) return { type: "없음" };
  if (CARE_RE.test(t)) return { type: "안부" };
  if (/장례|조문|경조사|결혼식|돌봄|응급|부모님|아이가 ?아|가족 ?(일|돌봄|상황)/.test(t)) return { type: "가족·응급" };
  if (/고열|열이|독감|코로나|병원|수술|입원|다쳤|통증|너무 ?아(프|파)/.test(t)) return { type: "심한 건강 문제" };
  if (/시험|마감|발표|면접|제출|과제/.test(t)) return { type: "시험·마감" };
  if (/야근|회의|업무|출장|근무|당직/.test(t)) return { type: "업무·야근" };
  if (/교통|파업|막차|차가 ?(막|고장)|운행|지하철/.test(t)) return { type: "이동 곤란" };
  if (/일정|겹|선약|다른 약속|약속이 ?또/.test(t)) return { type: "약속 겹침" };
  if (/피곤|졸려|컨디션|기운이 ?없|몸살|감기|머리가 ?(좀|아)/.test(t)) return { type: "가벼운 컨디션" };
  if (/스트레스|기분이? ?(안 ?좋|별로|나쁘)|힘들|속상/.test(t)) return { type: "감정" };
  if (/귀찮|가기 ?싫|나가기|가기가/.test(t)) return { type: "단순 귀찮음" };
  return { type: "기타" };
}

// "으로/로" 선택: 받침이 없거나 ㄹ 받침이면 "로"
function josaRo(word) {
  const c = word.charCodeAt(word.length - 1);
  if (c < 0xac00 || c > 0xd7a3) return "로";
  const jong = (c - 0xac00) % 28;
  return jong === 0 || jong === 8 ? "로" : "으로";
}

function decide({ weather, place, importance, category }) {
  const outdoor = place === "야외";
  const w = weatherScore(weather, outdoor);
  const reasonPts = REASON_POINTS[category] ?? 0;
  // 중요한 약속의 −15는 "불편한 정도"의 날씨(날씨 점수 40 미만)에만 적용한다.
  // 위험한 날씨와 개인 사정 점수는 깎지 않는다.
  const impAdj = importance === "중요" && w.score < 40 ? -Math.min(15, w.score) : 0;
  const score = Math.max(0, Math.min(100, w.score + reasonPts + impAdj));
  // 40~69점: 날씨가 주된 원인이면 장소 변경으로 풀 수 있지만,
  // 개인 사정이 주된 원인이면 장소를 바꿔도 해결되지 않으므로 미루기로 본다.
  const weatherLed = w.score >= reasonPts;
  let verdict = score >= 70 ? "미루기" : score >= 40 ? (weatherLed ? "실내로 변경" : "미루기") : "강행";
  const reasons = w.reasons.slice();
  if (!outdoor && w.reasons.length) reasons.push("실내 약속이라 날씨 영향은 40%만 반영했습니다");
  if (!outdoor && verdict === "실내로 변경") {
    verdict = "강행";
    reasons.push("이미 실내 약속이라 장소를 바꿀 필요는 없습니다");
  }
  if (score >= 40 && score < 70 && !weatherLed) {
    reasons.push("개인 사정이 주된 이유라 장소를 바꿔도 해결되지 않아 미루기로 봅니다");
  }
  if (category !== "없음" && category !== "안부") {
    reasons.push(`개인 사정은 "${category}"${josaRo(category)} 분류했고 점수 +${reasonPts}`);
  }
  if (importance === "중요") {
    reasons.push(impAdj < 0 ? `중요한 약속이라 날씨 점수를 ${-impAdj}점 낮췄습니다` : "중요한 약속이지만 위험한 날씨나 개인 사정은 점수를 낮추지 않습니다");
  }
  if (!reasons.length) reasons.push("특별한 위험 요소가 보이지 않습니다");
  return {
    verdict,
    score,
    parts: { weather: w.score, reason: reasonPts, importance: impAdj },
    reasons,
    missing: w.missing,
  };
}

module.exports = {
  PM_POINTS, REASON_POINTS, CATEGORIES, AI_CLASSES, CARE_RE,
  pmGradeFromValue, weatherScore, classifyByRule, decide,
};
