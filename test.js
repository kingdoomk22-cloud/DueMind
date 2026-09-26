const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duemind-test-'));
const db = path.join(dir, 'test.db');
const port = 3199;
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: {...process.env, PORT:String(port), HOST:'127.0.0.1', DUEMIND_DB_PATH:db},
  stdio:['ignore','pipe','pipe']
});
let stderr=''; child.stderr.on('data',d=>stderr+=d);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let cookie='';
async function req(url, opts={}){
  const headers={...(opts.body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...(opts.headers||{})};
  const r=await fetch(base+url,{...opts,headers});
  const set=r.headers.get('set-cookie'); if(set) cookie=set.split(';')[0];
  const text=await r.text(); const body=text?JSON.parse(text):null;
  if(!r.ok) throw new Error(`${r.status}: ${text}`);
  return {status:r.status,body};
}
(async()=>{
  try{
    for(let i=0;i<30;i++){try{await req('/api/health');break}catch{await sleep(100)}}
    const signup=await req('/api/auth/signup',{method:'POST',body:JSON.stringify({name:'Smoke User',email:'smoke@example.com',password:'password123'})});
    assert.equal(signup.status,201);
    const list=await req('/api/invoices'); assert.equal(list.body.invoices.length,2);
    const created=await req('/api/invoices',{method:'POST',body:JSON.stringify({client:'Client A',email:'billing@example.com',number:'INV-T1',amount:500,currency:'USD',due:'2026-09-20',payLink:'https://example.com/pay'})});
    const id=created.body.invoice.id; assert.ok(id);
    const draft=await req(`/api/invoices/${id}/draft`); assert.equal(draft.body.tone,'professional');
    const follow=await req(`/api/invoices/${id}/followup`,{method:'POST',body:JSON.stringify({subject:draft.body.subject,body:draft.body.body})}); assert.equal(follow.body.outbox.status,'queued');
    const reply=await req(`/api/invoices/${id}/reply`,{method:'POST',body:JSON.stringify({text:'We will pay on Friday'})}); assert.equal(reply.body.analysis.type,'promised');
    const outbox=await req('/api/outbox'); assert.equal(outbox.body.outbox.length,1);
    const dash=await req('/api/dashboard'); assert.ok(dash.body.outstanding>0);
    console.log('DueMind v4 smoke test passed');
  } catch (e){ console.error(e); console.error(stderr); process.exitCode=1; }
  finally { child.kill(); setTimeout(()=>{try{fs.rmSync(dir,{recursive:true,force:true})}catch{}},100); }
})();
