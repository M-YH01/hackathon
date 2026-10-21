// 기상청 단기예보의 강수량(PCP)·적설(SNO)·강수형태(PTY) 실제 응답 값을 확인하는 점검 스크립트.
// 실행: npm run check:kma   (.env의 DATA_GO_KR_KEY 사용, 키는 화면에 출력하지 않는다)
// 전국 19개 지역의 예보를 받아, 실제로 나온 값의 종류와 우리 코드가 읽은 숫자를 나란히 보여 준다.
const { REGIONS, pickBase, normKey, summarizeKma } = require("../lib/weather");

const KMA_URL = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst";

async function main() {
  const key = process.env.DATA_GO_KR_KEY;
  if (!key) { console.log("DATA_GO_KR_KEY가 없습니다. .env를 확인하세요."); process.exit(1); }
  const { baseDate, baseTime } = pickBase(new Date());
  console.log(`기준 발표: base_date ${baseDate}, base_time ${baseTime}\n`);
  const seen = { PCP: new Map(), SNO: new Map(), PTY: new Map() };
  for (const [name, r] of Object.entries(REGIONS)) {
    const u = new URL(KMA_URL);
    const q = { serviceKey: normKey(key), pageNo: 1, numOfRows: 1000, dataType: "JSON", base_date: baseDate, base_time: baseTime, nx: r.nx, ny: r.ny };
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    let items = [];
    try {
      const j = JSON.parse(await (await fetch(u)).text());
      items = (j.response.body.items && j.response.body.items.item) || [];
    } catch (e) { console.log(`${name}: 응답을 읽지 못했습니다`); continue; }
    for (const i of items) if (seen[i.category]) seen[i.category].set(i.fcstValue, (seen[i.category].get(i.fcstValue) || 0) + 1);
    // 가장 가까운 시각 기준으로 우리 코드가 읽은 값
    const today = baseDate;
    const w = summarizeKma(items, today, 15);
    if (w) console.log(`${name.padEnd(4)} 15시: 강수확률 ${w.pop}% · 강수형태 ${w.pty} · 강수량 ${w.pcp}mm · 적설 ${w.sno}cm`);
  }
  for (const cat of ["PCP", "SNO", "PTY"]) {
    console.log(`\n[${cat}] 실제로 나온 값(개수)`);
    for (const [v, n] of [...seen[cat].entries()].sort((a, b) => b[1] - a[1])) console.log(`  "${v}" × ${n}`);
  }
  console.log('\n비·눈이 없는 날은 "강수없음", "적설없음" 같은 값만 나옵니다. "1mm 미만", "30.0~50.0mm", "5.0cm 이상" 같은 값이 보이면 읽는 방식을 확인할 수 있습니다.');
}
main();
