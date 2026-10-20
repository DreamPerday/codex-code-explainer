// Development-only host bridge. Never shipped inside the installed plugin.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = new Client({ name: 'code-explainer-development-preview', version: '0.1' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist/plugin/dist/server.mjs'), '--stdio'], stderr: 'pipe', env: Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined)) });
await client.connect(transport);
const csrf = randomBytes(24).toString('hex');
const tools = (await client.listTools()).tools;
const allowed = new Set(tools.filter(t => t._meta?.ui?.visibility?.includes('app')).map(t => t.name));
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content.find(c => c.type === 'text')?.text ?? 'Tool failed');
  return result;
};
const seed = (await call('open_reader', process.argv[2] === '--empty' ? {} : { root: process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'examples/demo') })).structuredContent;
const hostHtml = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>代码随读 · 联调预览</title><style>body{margin:0;background:#f5f6f2;font:12px "Segoe UI","Microsoft YaHei",sans-serif}header{height:34px;display:flex;align-items:center;justify-content:center;color:#6c736b;background:#eef0e8;border-bottom:1px solid #dce3d8}iframe{display:block;width:100%;height:calc(100dvh - 35px);border:0}</style><header>开发预览 · 使用真实独立后台，不提供聊天消息接口</header><iframe title="代码随读" src="/reader"></iframe><script>
const frame=document.querySelector('iframe');const seed=${JSON.stringify(seed)};const token=${JSON.stringify(csrf)};
const send=m=>frame.contentWindow.postMessage(m,location.origin);
window.addEventListener('message',async event=>{
 if(event.source!==frame.contentWindow||event.origin!==location.origin)return;
 const m=event.data;if(!m||m.jsonrpc!=='2.0')return;
 try{
 let result={};
 if(m.method==='ui/message')throw new Error('Chat messages are disabled in this preview');
 if(m.method==='ui/initialize')result={protocolVersion:m.params.protocolVersion,hostInfo:{name:'development-preview',version:'1'},hostCapabilities:{serverTools:{},serverResources:{},updateModelContext:{text:{}},},hostContext:{theme:new URLSearchParams(location.search).get('theme')||'light',displayMode:'inline',availableDisplayModes:['inline','fullscreen'],containerDimensions:{width:innerWidth,height:innerHeight-35}}};
 else if(m.method==='ui/notifications/initialized'){send({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{content:[],structuredContent:seed}});return;}
 else if(m.method==='tools/call'){
  const r=await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json','X-Preview-Token':token},body:JSON.stringify(m)});result=await r.json();if(!r.ok)throw new Error(result.error||'Preview request failed');
 }
 if(m.id!==undefined)send({jsonrpc:'2.0',id:m.id,result});
 }catch(error){if(m.id!==undefined)send({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:error.message}});}
});</script></html>`;
const server = http.createServer(async (req, res) => {
  const requestOrigin = `http://${req.headers.host}`;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '') || (req.headers.origin && req.headers.origin !== requestOrigin)) { res.writeHead(403).end(); return; }
  try {
    if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
    if (req.method === 'GET' && req.url?.startsWith('/reader')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(await readFile(path.join(root, 'dist/plugin/dist/reader.html'))); return; }
    if (req.method === 'GET' && (req.url === '/' || req.url?.startsWith('/?'))) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(hostHtml); return; }
    if (req.method === 'POST' && req.url === '/rpc' && req.headers['x-preview-token'] === csrf) {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 50000) throw new Error('Request too large'); }
      const request = JSON.parse(body);
      res.setHeader('Content-Type', 'application/json');
      if (request.method === 'tools/call') {
        if (!allowed.has(request.params.name)) throw new Error('Tool unavailable to preview UI');
        res.end(JSON.stringify(await call(request.params.name, request.params.arguments))); return;
      }

    }
    res.writeHead(404).end();
  } catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message })); }
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`Preview http://127.0.0.1:${server.address().port}\n`));
async function shutdown() { server.close(); await client.close(); process.exit(0); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
