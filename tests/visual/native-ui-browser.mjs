import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
// Dedicated loopback fixture host; never use a real browser profile or provider.
const root=process.env.ZUDE_UI_EXPORT_DIR || '/tmp/zude-ui-foundation-web';
const server=http.createServer((req,res)=>{
 const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
 let file=path.join(root,pathname);if(!file.startsWith(root)){res.writeHead(403);res.end();return}
 if(!fs.existsSync(file)||!fs.statSync(file).isFile())file=path.join(root,'index.html');
 const mime={'.html':'text/html','.js':'application/javascript','.ttf':'font/ttf','.png':'image/png','.ico':'image/x-icon'};
 res.setHeader('content-type',mime[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
}).listen(8769,'127.0.0.1');
const chrome=spawn(process.env.ZUDE_CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','--use-mock-keychain','--password-store=basic','--remote-debugging-port=9339','--user-data-dir=/tmp/zude-ui-chrome-isolated','about:blank'],{stdio:'ignore'});
for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{chrome.kill();server.close();process.exit()});
console.log('Isolated fixture host and Chrome started');
setInterval(()=>{},1000);
