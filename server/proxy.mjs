// 可选的本地 CORS 代理（零依赖）：当 iFinD MCP 或某些 LLM 服务不允许浏览器直连时使用。
// 用法：IFIND_MCP_URL=<iFinD 配置中的 url> LLM_BASE=https://api.deepseek.com/v1 node server/proxy.mjs
// 前端设置：iFinD 地址填 http://localhost:8787/ifind ；LLM Base URL 填 http://localhost:8787/llm
// 密钥仍由前端请求头携带（Authorization / x-api-key），代理不落盘、不记录密钥。
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8787);
const ROUTES = {
  '/ifind': process.env.IFIND_MCP_URL,
  '/llm': process.env.LLM_BASE,
  '/fuyao': process.env.FUYAO_BASE ?? 'https://fuyao.aicubes.cn',
};
const PASS_REQ = ['content-type', 'accept', 'authorization', 'x-api-key', 'mcp-session-id', 'anthropic-version', 'anthropic-dangerous-direct-browser-access'];
const PASS_RES = ['content-type', 'mcp-session-id'];

function cors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Headers', PASS_REQ.join(','));
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

http
  .createServer(async (req, res) => {
    cors(res, req.headers.origin);
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    const prefix = Object.keys(ROUTES).find((p) => req.url === p || req.url.startsWith(p + '/') || req.url.startsWith(p + '?'));
    const base = prefix && ROUTES[prefix];
    if (!base) return res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unknown route or upstream not configured', routes: ROUTES }));
    const target = base.replace(/\/$/, '') + req.url.slice(prefix.length);
    const headers = {};
    for (const h of PASS_REQ) if (req.headers[h]) headers[h] = req.headers[h];
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      const up = await fetch(target, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
      const out = {};
      for (const h of PASS_RES) if (up.headers.get(h)) out[h] = up.headers.get(h);
      res.writeHead(up.status, out);
      res.end(Buffer.from(await up.arrayBuffer()));
      console.log(`${new Date().toISOString()} ${req.method} ${prefix} -> ${up.status}`);
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
  })
  .listen(PORT, () => console.log(`X-Buddy proxy on http://localhost:${PORT}`, ROUTES));
