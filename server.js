// 로컬 실행용 서버(의존성 없음): node --env-file=.env server.js
// Vercel에서는 이 파일 대신 public/ 정적 파일과 api/verdict.js 가 그대로 쓰인다.
const http = require("http");
const fs = require("fs");
const path = require("path");
const handler = require("./api/verdict");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/verdict") {
    try { return await handler(req, res); }
    catch (e) { res.statusCode = 500; return res.end(JSON.stringify({ error: "서버 오류" })); }
  }
  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  const full = path.normalize(path.join(PUBLIC, file));
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.statusCode = 404;
    return res.end("Not found");
  }
  res.setHeader("Content-Type", TYPES[path.extname(full)] || "application/octet-stream");
  fs.createReadStream(full).pipe(res);
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
