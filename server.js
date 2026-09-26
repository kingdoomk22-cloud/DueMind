const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PUBLIC = fs.existsSync(PUBLIC_DIR) ? PUBLIC_DIR : ROOT;
const FLAT_PUBLIC = PUBLIC === ROOT;
const FLAT_ALLOWED = new Set(['/index.html','/404.html','/app.js','/styles.css']);
const DATA_DIR = process.env.DUEMIND_DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DUEMIND_DB_PATH || path.join(DATA_DIR, 'duemind.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

function nowISO(){ return new Date().toISOString(); }
function todayISO(){ return new Date().toISOString().slice(0,10); }
function uid(){ return crypto.randomUUID(); }
function daysBetween(a,b){
  const A = new Date(`${a}T00:00:00Z`), B = new Date(`${b}T00:00:00Z`);
  return Math.floor((B - A) / 86400000);
}
function addDaysISO(days){ const d = new Date(); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); }
function nextWeekday(target){ const map={sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6}; const d=new Date(); const delta=(map[target]-d.getDay()+7)%7 || 7; d.setDate(d.getDate()+delta); return d.toISOString().slice(0,10); }

function initSchema(){
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      business TEXT NOT NULL DEFAULT 'My Business',
      sender TEXT NOT NULL DEFAULT 'Accounts',
      tone TEXT NOT NULL DEFAULT 'balanced',
      currency TEXT NOT NULL DEFAULT 'USD'
    );
    CREATE TABLE IF NOT EXISTS templates (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY (user_id, stage)
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client TEXT NOT NULL,
      email TEXT NOT NULL,
      number TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      due TEXT NOT NULL,
      pay_link TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      reminders INTEGER NOT NULL DEFAULT 0,
      last_action TEXT,
      promise_date TEXT,
      paid_date TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id);
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      text TEXT NOT NULL,
      event_date TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_invoice ON events(invoice_id);
    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL
    );
  `);
}
initSchema();

const DEFAULT_TEMPLATES = {
  friendly: `Hi {{client}},\n\nJust a quick reminder that invoice {{invoice}} for {{amount}} was due on {{due}}. If payment is already on the way, please disregard this note.\n\n{{payment}}\n\nThanks,\n{{sender}}`,
  professional: `Hi {{client}},\n\nI am following up on invoice {{invoice}} for {{amount}}, which was due on {{due}}. Could you please confirm the payment status or let me know the expected payment date?\n\n{{payment}}\n\nRegards,\n{{sender}}`,
  firm: `Hi {{client}},\n\nInvoice {{invoice}} for {{amount}} remains outstanding after its due date of {{due}}. Please arrange payment or confirm a firm payment date.\n\n{{payment}}\n\nRegards,\n{{sender}}`,
  final: `Hi {{client}},\n\nThis is a final payment follow-up for invoice {{invoice}} for {{amount}}, due on {{due}}. Please settle the balance or contact us immediately if there is an issue we should review.\n\n{{payment}}\n\nRegards,\n{{sender}}`
};

function pbkdf(password, salt){ return crypto.scryptSync(password, salt, 64).toString('hex'); }
function hashPassword(password){ const salt=crypto.randomBytes(16).toString('hex'); return `${salt}:${pbkdf(password,salt)}`; }
function verifyPassword(password, stored){ const [salt, hash] = stored.split(':'); if(!salt||!hash) return false; const test=Buffer.from(pbkdf(password,salt),'hex'), real=Buffer.from(hash,'hex'); return test.length===real.length && crypto.timingSafeEqual(test,real); }
function hashToken(token){ return crypto.createHash('sha256').update(token).digest('hex'); }
function parseCookies(req){ const out={}; const raw=req.headers.cookie||''; for(const part of raw.split(';')){ const i=part.indexOf('='); if(i>0) out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim()); } return out; }
function newSession(userId){
  const token=crypto.randomBytes(32).toString('base64url');
  const expires=new Date(Date.now()+1000*60*60*24*30).toISOString();
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(hashToken(token),userId,expires,nowISO());
  return {token,expires};
}
function getAuth(req){
  const token=parseCookies(req).duemind_session; if(!token) return null;
  const row=db.prepare(`SELECT s.user_id,u.name,u.email,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(hashToken(token));
  if(!row) return null;
  if(new Date(row.expires_at)<new Date()){ db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token)); return null; }
  return {id:row.user_id,name:row.name,email:row.email,token};
}
function seedInvoicesOnly(userId){
  const samples=[
    {client:'Smith Agency',email:'billing@smith.example',number:'INV-1042',amount:850,currency:'USD',due:addDaysISO(-7),payLink:'https://example.com/pay/1042'},
    {client:'Acme Studio',email:'finance@acme.example',number:'INV-1023',amount:2400,currency:'USD',due:addDaysISO(-3),payLink:'https://example.com/pay/1023'}
  ];
  for(const s of samples){ const id=uid(),ts=nowISO(); db.prepare(`INSERT INTO invoices(id,user_id,client,email,number,amount,currency,due,pay_link,status,reminders,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'open',0,?,?)`).run(id,userId,s.client,s.email,s.number,s.amount,s.currency,s.due,s.payLink,ts,ts); addEvent(userId,id,'created','Demo invoice added'); }
}
function seedUser(userId,business){
  db.prepare('INSERT INTO settings(user_id,business,sender,tone,currency) VALUES(?,?,?,?,?)').run(userId,business||'My Business','Accounts','balanced','USD');
  const t=db.prepare('INSERT INTO templates(user_id,stage,body) VALUES(?,?,?)'); for(const [stage,body] of Object.entries(DEFAULT_TEMPLATES)) t.run(userId,stage,body);
  seedInvoicesOnly(userId);
}
function addEvent(userId,invoiceId,type,text,date=todayISO()){ db.prepare('INSERT INTO events(id,invoice_id,user_id,type,text,event_date,created_at) VALUES(?,?,?,?,?,?,?)').run(uid(),invoiceId,userId,type,text,date,nowISO()); }

function json(res,status,data,headers={}){ res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers}); res.end(JSON.stringify(data)); }
function noContent(res,status=204,headers={}){ res.writeHead(status,headers); res.end(); }
function bad(res,message,status=400){ json(res,status,{error:message}); }
async function readJson(req){
  const chunks=[]; let size=0;
  for await(const c of req){ size+=c.length; if(size>1_000_000) throw new Error('Body too large'); chunks.push(c); }
  if(!chunks.length) return {};
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('Invalid JSON');}
}
function requireAuth(req,res){ const a=getAuth(req); if(!a){ bad(res,'Authentication required',401); return null;} return a; }
function validEmail(v){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v||'')); }
function normalizeInvoice(row){ if(!row)return null; return {id:row.id,client:row.client,email:row.email,number:row.number,amount:row.amount,currency:row.currency,due:row.due,payLink:row.pay_link,status:row.status,reminders:row.reminders,lastAction:row.last_action,promiseDate:row.promise_date,paidDate:row.paid_date,createdAt:row.created_at,updatedAt:row.updated_at}; }
function listEvents(userId,invoiceId){ return db.prepare('SELECT type,text,event_date AS date,created_at FROM events WHERE user_id=? AND invoice_id=? ORDER BY created_at DESC').all(userId,invoiceId); }
function getInvoice(userId,id){ const row=db.prepare('SELECT * FROM invoices WHERE user_id=? AND id=?').get(userId,id); if(!row) return null; const inv=normalizeInvoice(row); inv.events=listEvents(userId,id); return inv; }
function listInvoices(userId){ return db.prepare('SELECT * FROM invoices WHERE user_id=? ORDER BY created_at DESC').all(userId).map(normalizeInvoice); }
function getSettings(userId){ return db.prepare('SELECT business,sender,tone,currency FROM settings WHERE user_id=?').get(userId); }
function getTemplates(userId){ const rows=db.prepare('SELECT stage,body FROM templates WHERE user_id=?').all(userId); return Object.fromEntries(rows.map(r=>[r.stage,r.body])); }
function currency(amount,code){ try{return new Intl.NumberFormat('en-US',{style:'currency',currency:code}).format(amount);}catch{return `${code} ${Number(amount).toFixed(2)}`;} }
function resolveTone(inv){ const late=daysBetween(inv.due,todayISO()); if(late<=3)return 'friendly'; if(late<=10)return 'professional'; if(late<=21)return 'firm'; return 'final'; }
function buildSubject(inv,tone){ const prefix={friendly:'Quick reminder',professional:'Payment follow-up',firm:'Outstanding invoice',final:'Final payment follow-up'}[tone]; return `${prefix}: ${inv.number}`; }
function fillTemplate(text,inv,settings){ return text.replaceAll('{{client}}',inv.client).replaceAll('{{invoice}}',inv.number).replaceAll('{{amount}}',currency(inv.amount,inv.currency)).replaceAll('{{due}}',inv.due).replaceAll('{{payment}}',inv.payLink?`Payment link: ${inv.payLink}`:'').replaceAll('{{sender}}',settings.sender||'Accounts'); }
function draftFor(userId,inv){ const settings=getSettings(userId), templates=getTemplates(userId), tone=resolveTone(inv); return {tone,subject:buildSubject(inv,tone),body:fillTemplate(templates[tone]||DEFAULT_TEMPLATES[tone],inv,settings)}; }
function detectPromiseDate(text){ const lower=text.toLowerCase(); for(const day of ['sunday','monday','tuesday','wednesday','thursday','friday','saturday']) if(lower.includes(day)) return nextWeekday(day); if(lower.includes('tomorrow'))return addDaysISO(1); if(lower.includes('next week'))return addDaysISO(7); const iso=text.match(/\b(20\d{2}-\d{2}-\d{2})\b/); return iso?.[1]||addDaysISO(3); }
function analyzeReply(text){ const lower=text.toLowerCase(); if(/\b(paid|payment sent|transferred|settled)\b/.test(lower)) return {type:'paid',confidence:0.95}; if(/\b(dispute|wrong invoice|incorrect|not correct|problem with invoice)\b/.test(lower)) return {type:'disputed',confidence:0.92}; if(/\b(pay|payment|send|transfer)\b/.test(lower)&&/(tomorrow|friday|monday|tuesday|wednesday|thursday|saturday|sunday|next week|20\d{2}-\d{2}-\d{2})/.test(lower)) return {type:'promised',date:detectPromiseDate(text),confidence:0.9}; return {type:'reply',confidence:0.55}; }
function dashboard(userId){ const invs=listInvoices(userId); let outstanding=0,overdue=0,promises=0,actions=0; const today=todayISO(); for(const i of invs){ if(i.status==='paid')continue; outstanding+=i.amount; const late=daysBetween(i.due,today); if(late>0)overdue+=i.amount; if(i.status==='promised'){promises++; if(i.promiseDate&&i.promiseDate<=today)actions++;} else if(i.status==='disputed'){actions++;} else if(late>0){actions++;} }
  return {outstanding,overdue,promises,actions,currency:getSettings(userId)?.currency||'USD'};
}

const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon'};
function serveStatic(req,res){ let p=decodeURIComponent(new URL(req.url,'http://localhost').pathname); if(p==='/')p='/index.html'; if(FLAT_PUBLIC && !FLAT_ALLOWED.has(p)){ const fallback=path.join(PUBLIC,'index.html'); return fs.readFile(fallback,(e,b)=>{if(e)return bad(res,'Not found',404);res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-cache'});res.end(b);}); } const full=path.normalize(path.join(PUBLIC,p)); if(!full.startsWith(PUBLIC))return bad(res,'Forbidden',403); fs.stat(full,(err,st)=>{ if(err||!st.isFile()){ const fallback=path.join(PUBLIC,'index.html'); fs.readFile(fallback,(e,b)=>{if(e)return bad(res,'Not found',404);res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-cache'});res.end(b);});return;} fs.readFile(full,(e,b)=>{if(e)return bad(res,'Read error',500);res.writeHead(200,{'content-type':mime[path.extname(full)]||'application/octet-stream','cache-control':p.endsWith('.html')?'no-cache':'public, max-age=300'});res.end(b);}); }); }

async function api(req,res){
  const u=new URL(req.url,'http://localhost'); const pathname=u.pathname; const method=req.method;
  if(pathname==='/api/health'&&method==='GET')return json(res,200,{ok:true,version:'0.4.0',database:'sqlite',time:nowISO()});
  if(pathname==='/api/auth/signup'&&method==='POST'){
    let b; try{b=await readJson(req);}catch(e){return bad(res,e.message);}
    const name=String(b.name||'').trim(),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||''),business=String(b.business||'').trim();
    if(name.length<2)return bad(res,'Name is required'); if(!validEmail(email))return bad(res,'Valid email is required'); if(password.length<8)return bad(res,'Password must be at least 8 characters');
    if(db.prepare('SELECT id FROM users WHERE email=?').get(email))return bad(res,'Account already exists',409);
    const id=uid(); db.prepare('INSERT INTO users(id,name,email,password_hash,created_at) VALUES(?,?,?,?,?)').run(id,name,email,hashPassword(password),nowISO()); seedUser(id,business||`${name}'s Business`); const s=newSession(id);
    return json(res,201,{user:{id,name,email}}, {'set-cookie':`duemind_session=${encodeURIComponent(s.token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`});
  }
  if(pathname==='/api/auth/login'&&method==='POST'){
    let b;try{b=await readJson(req);}catch(e){return bad(res,e.message);} const email=String(b.email||'').trim().toLowerCase(),password=String(b.password||''); const row=db.prepare('SELECT * FROM users WHERE email=?').get(email); if(!row||!verifyPassword(password,row.password_hash))return bad(res,'Invalid email or password',401); const s=newSession(row.id); return json(res,200,{user:{id:row.id,name:row.name,email:row.email}}, {'set-cookie':`duemind_session=${encodeURIComponent(s.token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`});
  }
  if(pathname==='/api/auth/logout'&&method==='POST'){
    const a=getAuth(req); if(a)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(a.token)); return noContent(res,204,{'set-cookie':'duemind_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0'});
  }
  if(pathname==='/api/me'&&method==='GET'){const a=requireAuth(req,res);if(!a)return;return json(res,200,{user:{id:a.id,name:a.name,email:a.email},settings:getSettings(a.id)});}
  const a=requireAuth(req,res); if(!a)return;

  if(pathname==='/api/dashboard'&&method==='GET')return json(res,200,dashboard(a.id));
  if(pathname==='/api/invoices'&&method==='GET')return json(res,200,{invoices:listInvoices(a.id)});
  if(pathname==='/api/invoices'&&method==='POST'){
    let b;try{b=await readJson(req);}catch(e){return bad(res,e.message);} const client=String(b.client||'').trim(),email=String(b.email||'').trim(),number=String(b.number||'').trim(),amount=Number(b.amount),currencyCode=String(b.currency||getSettings(a.id).currency||'USD').trim().toUpperCase(),due=String(b.due||'').trim(),payLink=String(b.payLink||'').trim();
    if(!client||!number||!validEmail(email)||!Number.isFinite(amount)||amount<=0||!/^\d{4}-\d{2}-\d{2}$/.test(due))return bad(res,'Client, valid email, invoice number, positive amount, and due date are required');
    const id=uid(),ts=nowISO();db.prepare(`INSERT INTO invoices(id,user_id,client,email,number,amount,currency,due,pay_link,status,reminders,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'open',0,?,?)`).run(id,a.id,client,email,number,amount,currencyCode,due,payLink,ts,ts);addEvent(a.id,id,'created','Invoice added');return json(res,201,{invoice:getInvoice(a.id,id)});
  }
  const invoiceMatch=pathname.match(/^\/api\/invoices\/([^/]+)$/);
  if(invoiceMatch&&method==='PUT'){
    const id=invoiceMatch[1],existing=getInvoice(a.id,id);if(!existing)return bad(res,'Invoice not found',404);let b;try{b=await readJson(req);}catch(e){return bad(res,e.message);} const client=String(b.client??existing.client).trim(),email=String(b.email??existing.email).trim(),number=String(b.number??existing.number).trim(),amount=Number(b.amount??existing.amount),currencyCode=String(b.currency??existing.currency).trim().toUpperCase(),due=String(b.due??existing.due).trim(),payLink=String(b.payLink??existing.payLink).trim(); if(!client||!number||!validEmail(email)||!Number.isFinite(amount)||amount<=0||!/^\d{4}-\d{2}-\d{2}$/.test(due))return bad(res,'Invalid invoice data'); db.prepare('UPDATE invoices SET client=?,email=?,number=?,amount=?,currency=?,due=?,pay_link=?,updated_at=? WHERE user_id=? AND id=?').run(client,email,number,amount,currencyCode,due,payLink,nowISO(),a.id,id);addEvent(a.id,id,'edited','Invoice updated');return json(res,200,{invoice:getInvoice(a.id,id)});
  }
  if(invoiceMatch&&method==='DELETE'){const id=invoiceMatch[1];const r=db.prepare('DELETE FROM invoices WHERE user_id=? AND id=?').run(a.id,id);if(!r.changes)return bad(res,'Invoice not found',404);return noContent(res);}

  const draftMatch=pathname.match(/^\/api\/invoices\/([^/]+)\/draft$/);
  if(draftMatch&&method==='GET'){const inv=getInvoice(a.id,draftMatch[1]);if(!inv)return bad(res,'Invoice not found',404);return json(res,200,draftFor(a.id,inv));}
  const approveMatch=pathname.match(/^\/api\/invoices\/([^/]+)\/followup$/);
  if(approveMatch&&method==='POST'){const inv=getInvoice(a.id,approveMatch[1]);if(!inv)return bad(res,'Invoice not found',404);let b;try{b=await readJson(req);}catch(e){return bad(res,e.message);}const subject=String(b.subject||'').trim(),body=String(b.body||'').trim();if(!subject||!body)return bad(res,'Subject and body are required');const outboxId=uid();db.prepare('INSERT INTO outbox(id,user_id,invoice_id,recipient,subject,body,status,created_at) VALUES(?,?,?,?,?,?,'+"'queued'"+',?)').run(outboxId,a.id,inv.id,inv.email,subject,body,nowISO());db.prepare('UPDATE invoices SET reminders=reminders+1,last_action=?,updated_at=? WHERE user_id=? AND id=?').run(todayISO(),nowISO(),a.id,inv.id);addEvent(a.id,inv.id,'followup',`Follow-up queued: ${subject}`);return json(res,201,{outbox:{id:outboxId,status:'queued'},invoice:getInvoice(a.id,inv.id)});}
  const replyMatch=pathname.match(/^\/api\/invoices\/([^/]+)\/reply$/);
  if(replyMatch&&method==='POST'){const inv=getInvoice(a.id,replyMatch[1]);if(!inv)return bad(res,'Invoice not found',404);let b;try{b=await readJson(req);}catch(e){return bad(res,e.message);}const text=String(b.text||'').trim();if(!text)return bad(res,'Reply text is required');const r=analyzeReply(text);if(r.type==='paid'){db.prepare("UPDATE invoices SET status='paid',paid_date=?,updated_at=? WHERE user_id=? AND id=?").run(todayISO(),nowISO(),a.id,inv.id);addEvent(a.id,inv.id,'paid','Client reply interpreted as paid');}else if(r.type==='disputed'){db.prepare("UPDATE invoices SET status='disputed',updated_at=? WHERE user_id=? AND id=?").run(nowISO(),a.id,inv.id);addEvent(a.id,inv.id,'dispute','Client reply interpreted as a dispute');}else if(r.type==='promised'){db.prepare("UPDATE invoices SET status='promised',promise_date=?,updated_at=? WHERE user_id=? AND id=?").run(r.date,nowISO(),a.id,inv.id);addEvent(a.id,inv.id,'promise',`Payment promised for ${r.date}`);}else{addEvent(a.id,inv.id,'reply','Client replied; manual review needed');}return json(res,200,{analysis:r,invoice:getInvoice(a.id,inv.id)});}
  const paidMatch=pathname.match(/^\/api\/invoices\/([^/]+)\/paid$/);
  if(paidMatch&&method==='POST'){const inv=getInvoice(a.id,paidMatch[1]);if(!inv)return bad(res,'Invoice not found',404);db.prepare("UPDATE invoices SET status='paid',paid_date=?,updated_at=? WHERE user_id=? AND id=?").run(todayISO(),nowISO(),a.id,inv.id);addEvent(a.id,inv.id,'paid','Marked paid');return json(res,200,{invoice:getInvoice(a.id,inv.id)});}

  if(pathname==='/api/settings'&&method==='GET')return json(res,200,getSettings(a.id));
  if(pathname==='/api/settings'&&method==='PUT'){let b;try{b=await readJson(req);}catch(e){return bad(res,e.message);}const current=getSettings(a.id),business=String(b.business??current.business).trim()||'My Business',sender=String(b.sender??current.sender).trim()||'Accounts',tone=String(b.tone??current.tone),currencyCode=String(b.currency??current.currency).trim().toUpperCase()||'USD';db.prepare('UPDATE settings SET business=?,sender=?,tone=?,currency=? WHERE user_id=?').run(business,sender,tone,currencyCode,a.id);return json(res,200,getSettings(a.id));}
  if(pathname==='/api/templates'&&method==='GET')return json(res,200,getTemplates(a.id));
  if(pathname==='/api/templates'&&method==='PUT'){let b;try{b=await readJson(req);}catch(e){return bad(res,e.message);}for(const stage of Object.keys(DEFAULT_TEMPLATES)){if(typeof b[stage]==='string')db.prepare('INSERT INTO templates(user_id,stage,body) VALUES(?,?,?) ON CONFLICT(user_id,stage) DO UPDATE SET body=excluded.body').run(a.id,stage,b[stage]);}return json(res,200,getTemplates(a.id));}
  if(pathname==='/api/templates/reset'&&method==='POST'){const q=db.prepare('INSERT INTO templates(user_id,stage,body) VALUES(?,?,?) ON CONFLICT(user_id,stage) DO UPDATE SET body=excluded.body');for(const [stage,body] of Object.entries(DEFAULT_TEMPLATES))q.run(a.id,stage,body);return json(res,200,getTemplates(a.id));}
  if(pathname==='/api/outbox'&&method==='GET'){return json(res,200,{outbox:db.prepare('SELECT id,invoice_id AS invoiceId,recipient,subject,body,status,created_at AS createdAt FROM outbox WHERE user_id=? ORDER BY created_at DESC').all(a.id)});}
  if(pathname==='/api/export'&&method==='GET'){return json(res,200,{user:{name:a.name,email:a.email},settings:getSettings(a.id),templates:getTemplates(a.id),invoices:listInvoices(a.id).map(i=>({...i,events:listEvents(a.id,i.id)})),outbox:db.prepare('SELECT * FROM outbox WHERE user_id=? ORDER BY created_at DESC').all(a.id)});}
  if(pathname==='/api/reset'&&method==='POST'){db.prepare('DELETE FROM outbox WHERE user_id=?').run(a.id);db.prepare('DELETE FROM events WHERE user_id=?').run(a.id);db.prepare('DELETE FROM invoices WHERE user_id=?').run(a.id);db.prepare('DELETE FROM templates WHERE user_id=?').run(a.id);for(const [stage,body] of Object.entries(DEFAULT_TEMPLATES))db.prepare('INSERT INTO templates(user_id,stage,body) VALUES(?,?,?)').run(a.id,stage,body);const s=getSettings(a.id);seedInvoicesOnly(a.id);return json(res,200,{ok:true});}
  return bad(res,'API route not found',404);
}

const server=http.createServer(async(req,res)=>{
  try{
    if(req.url.startsWith('/api/')) return await api(req,res);
    return serveStatic(req,res);
  }catch(err){ console.error(err); if(!res.headersSent)json(res,500,{error:'Internal server error'}); else res.end(); }
});

if(require.main===module){ server.listen(PORT,HOST,()=>console.log(`DueMind v4 running on http://${HOST}:${PORT}`)); }
module.exports={server,db,DB_PATH};
