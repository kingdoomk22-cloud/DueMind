(()=>{
  const $=id=>document.getElementById(id), qsa=s=>[...document.querySelectorAll(s)];
  let authMode='signup', activeInvoiceId=null;
  let state={user:null,settings:{business:'My Business',sender:'Accounts',tone:'balanced',currency:'USD'},templates:{},invoices:[],dashboard:{outstanding:0,overdue:0,promises:0,actions:0,currency:'USD'}};

  const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const todayISO=()=>new Date().toISOString().slice(0,10);
  const daysLate=due=>Math.max(0,Math.floor((new Date(`${todayISO()}T00:00:00Z`)-new Date(`${due}T00:00:00Z`))/86400000));
  const money=(n,c='USD')=>{try{return new Intl.NumberFormat('en-US',{style:'currency',currency:c}).format(Number(n)||0)}catch{return `${c} ${Number(n||0).toFixed(2)}`}};
  function toast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');clearTimeout(toast._t);toast._t=setTimeout(()=>t.classList.remove('show'),2800);}
  function openModal(id){$(id).classList.remove('hidden');document.body.classList.add('modal-open');}
  function closeModal(id){$(id).classList.add('hidden');if(!qsa('.modal-backdrop:not(.hidden)').length)document.body.classList.remove('modal-open');}

  async function api(path,opts={}){
    const res=await fetch(path,{credentials:'same-origin',headers:{'content-type':'application/json',...(opts.headers||{})},...opts});
    let body=null; if(res.status!==204){const text=await res.text(); try{body=text?JSON.parse(text):null}catch{body={error:text||'Request failed'}}}
    if(!res.ok){const e=new Error(body?.error||`Request failed (${res.status})`);e.status=res.status;throw e;}
    return body;
  }

  function showLanding(){ $('landingView').classList.remove('hidden');$('appView').classList.add('hidden');$('publicNav').classList.remove('hidden');$('appNav').classList.add('hidden'); }
  function showApp(){ $('landingView').classList.add('hidden');$('appView').classList.remove('hidden');$('publicNav').classList.add('hidden');$('appNav').classList.remove('hidden');$('userChip').textContent=state.user?.name||state.user?.email||'Account'; renderAll(); }
  function updateAuthModal(){ const signup=authMode==='signup';$('authTitle').textContent=signup?'Create your DueMind account':'Log in to DueMind';$('authIntro').textContent=signup?'Server-backed MVP: your data is stored in SQLite on this instance.':'Use the account you created on this DueMind instance.';$('nameField').classList.toggle('hidden',!signup);$('authName').required=signup;$('authSubmit').textContent=signup?'Create account':'Log in';$('toggleAuthMode').textContent=signup?'Already have an account? Log in':'Need an account? Sign up'; }
  function requireAuth(mode){authMode=mode;updateAuthModal();$('authForm').reset();openModal('authModal');}

  async function loadAll(){
    const [me,invs,dash,templates]=await Promise.all([api('/api/me'),api('/api/invoices'),api('/api/dashboard'),api('/api/templates')]);
    state.user=me.user; state.settings=me.settings; state.invoices=invs.invoices; state.dashboard=dash; state.templates=templates; renderAll();
  }
  async function boot(){try{await loadAll();showApp();}catch(e){if(e.status!==401)console.error(e);showLanding();}}

  function statusMeta(inv){
    if(inv.status==='paid')return ['Paid','good'];
    if(inv.status==='promised')return [`Promise ${inv.promiseDate||''}`,'good'];
    if(inv.status==='disputed')return ['Dispute','danger'];
    const late=daysLate(inv.due); return late?[`${late}d overdue`,'warn']:['Open','neutral'];
  }
  function actionNeeded(inv){ if(inv.status==='paid')return false;if(inv.status==='disputed')return true;if(inv.status==='promised')return !!inv.promiseDate&&inv.promiseDate<=todayISO();return daysLate(inv.due)>0; }
  function toneFor(inv){const d=daysLate(inv.due);if(d<=3)return 'friendly';if(d<=10)return 'professional';if(d<=21)return 'firm';return 'final';}
  function actionCopy(inv){if(inv.status==='disputed')return 'Client raised an issue. Review manually before sending anything.';if(inv.status==='promised')return inv.promiseDate<=todayISO()?`Payment promise (${inv.promiseDate}) has passed. Follow up now.`:`Waiting for promised payment on ${inv.promiseDate}.`;const d=daysLate(inv.due);return `Recommended: ${toneFor(inv)} follow-up · ${d} day${d===1?'':'s'} overdue`;}

  function renderAll(){
    $('workspaceName').textContent=state.settings.business||'My Business';$('userChip').textContent=state.user?.name||state.user?.email||'Account';
    $('navActionCount').textContent=state.dashboard.actions||0;$('navInvoiceCount').textContent=state.invoices.length;
    $('statOutstanding').textContent=money(state.dashboard.outstanding,state.dashboard.currency||state.settings.currency);$('statOverdue').textContent=money(state.dashboard.overdue,state.dashboard.currency||state.settings.currency);$('statActions').textContent=state.dashboard.actions||0;$('statPromises').textContent=state.dashboard.promises||0;
    renderToday();renderInvoices();renderTemplates();renderSettings();
  }
  function renderToday(){
    const actions=state.invoices.filter(actionNeeded).sort((a,b)=>daysLate(b.due)-daysLate(a.due));
    $('actionsList').innerHTML=actions.length?actions.map(inv=>{const [label,cls]=statusMeta(inv);return `<article class="action-card"><div class="action-head"><div><strong>${esc(inv.client)}</strong><span>${esc(inv.number)} · ${esc(money(inv.amount,inv.currency))}</span></div><span class="badge ${cls}">${esc(label)}</span></div><p>${esc(actionCopy(inv))}</p><div class="row-actions">${inv.status!=='disputed'?`<button class="btn primary compact" data-draft="${inv.id}">Draft follow-up</button>`:''}<button class="btn compact" data-reply="${inv.id}">Add client reply</button>${inv.status!=='paid'?`<button class="link-button" data-paid="${inv.id}">Mark paid</button>`:''}</div></article>`}).join(''):`<div class="empty-state"><strong>Nothing needs attention right now.</strong><span>DueMind will surface overdue invoices and missed payment promises here.</span></div>`;
    const overdueCount=state.invoices.filter(i=>i.status!=='paid'&&daysLate(i.due)>0).length;
    $('healthPanel').innerHTML=`<div class="health-row"><span>Server database</span><strong>Connected</strong></div><div class="health-row"><span>Open invoices</span><strong>${state.invoices.filter(i=>i.status!=='paid').length}</strong></div><div class="health-row"><span>Overdue invoices</span><strong>${overdueCount}</strong></div><div class="health-row"><span>Email delivery</span><strong>Outbox only</strong></div><p class="fine-print">Approved follow-ups are stored in the server outbox. Real email delivery is the next integration.</p>`;
  }
  function renderInvoices(){
    const q=$('invoiceSearch').value.trim().toLowerCase(),f=$('invoiceFilter').value;
    const rows=state.invoices.filter(i=>(!q||`${i.client} ${i.number} ${i.email}`.toLowerCase().includes(q))&&(f==='all'||(f==='open'&&['open','disputed'].includes(i.status))||i.status===f));
    $('invoiceRows').innerHTML=rows.map(inv=>{const [label,cls]=statusMeta(inv);return `<tr><td><strong>${esc(inv.client)}</strong><small>${esc(inv.email)}</small></td><td>${esc(inv.number)}</td><td>${esc(money(inv.amount,inv.currency))}</td><td>${esc(inv.due)}</td><td><span class="badge ${cls}">${esc(label)}</span></td><td><div class="table-actions"><button class="link-button" data-edit="${inv.id}">Edit</button>${inv.status!=='paid'?`<button class="link-button" data-draft="${inv.id}">Draft</button>`:''}<button class="link-button danger" data-delete="${inv.id}">Delete</button></div></td></tr>`}).join('');
    $('invoiceEmpty').classList.toggle('hidden',rows.length>0);
  }
  function renderTemplates(){const labels={friendly:['Friendly','1-3 days overdue'],professional:['Professional','4-10 days overdue'],firm:['Firm','11-21 days overdue'],final:['Final','22+ days overdue']};$('templateGrid').innerHTML=Object.entries(labels).map(([key,[name,desc]])=>`<article class="template-card"><span class="label">${esc(desc)}</span><h3>${esc(name)}</h3><p>Variables: {{client}}, {{invoice}}, {{amount}}, {{due}}, {{payment}}, {{sender}}</p><textarea data-template="${key}">${esc(state.templates[key]||'')}</textarea></article>`).join('');}
  function renderSettings(){$('settingsBusiness').value=state.settings.business||'';$('settingsSender').value=state.settings.sender||'';$('settingsTone').value=state.settings.tone||'balanced';$('settingsCurrency').value=state.settings.currency||'USD';}
  function switchView(view){qsa('.side-link').forEach(b=>b.classList.toggle('active',b.dataset.view===view));qsa('.app-section').forEach(s=>s.classList.add('hidden'));$(`${view}Section`).classList.remove('hidden');if(view==='invoices')renderInvoices();if(view==='templates')renderTemplates();}

  function openInvoice(inv=null){$('invoiceForm').reset();$('invoiceId').value=inv?.id||'';$('invoiceModalTitle').textContent=inv?'Edit invoice':'Add invoice';$('clientName').value=inv?.client||'';$('clientEmail').value=inv?.email||'';$('invoiceNumber').value=inv?.number||'';$('invoiceAmount').value=inv?.amount||'';$('invoiceCurrency').value=inv?.currency||state.settings.currency||'USD';$('invoiceDue').value=inv?.due||todayISO();$('invoicePayLink').value=inv?.payLink||'';openModal('invoiceModal');}
  async function openDraft(id){try{activeInvoiceId=id;const inv=state.invoices.find(i=>i.id===id),d=await api(`/api/invoices/${id}/draft`);$('followupTitle').textContent=`${d.tone[0].toUpperCase()+d.tone.slice(1)} follow-up`;$('followupSub').textContent=`${inv.client} · ${inv.number} · ${money(inv.amount,inv.currency)}`;$('followupSubject').value=d.subject;$('followupText').value=d.body;openModal('followupModal');}catch(e){toast(e.message)}}
  function openReply(id){activeInvoiceId=id;$('replyText').value='';openModal('replyModal');}

  $('authForm').addEventListener('submit',async e=>{e.preventDefault();const payload={email:$('authEmail').value.trim().toLowerCase(),password:$('authPassword').value};if(authMode==='signup')payload.name=$('authName').value.trim();try{const r=await api(authMode==='signup'?'/api/auth/signup':'/api/auth/login',{method:'POST',body:JSON.stringify(payload)});state.user=r.user;closeModal('authModal');await loadAll();showApp();toast(authMode==='signup'?'Account created':'Logged in');}catch(err){toast(err.message)}});
  $('toggleAuthMode').addEventListener('click',()=>{authMode=authMode==='signup'?'login':'signup';updateAuthModal();});
  $('logoutBtn').addEventListener('click',async()=>{try{await api('/api/auth/logout',{method:'POST',body:'{}'})}catch{}state.user=null;showLanding();toast('Logged out');});

  $('invoiceForm').addEventListener('submit',async e=>{e.preventDefault();const id=$('invoiceId').value,payload={client:$('clientName').value.trim(),email:$('clientEmail').value.trim(),number:$('invoiceNumber').value.trim(),amount:Number($('invoiceAmount').value),currency:$('invoiceCurrency').value,due:$('invoiceDue').value,payLink:$('invoicePayLink').value.trim()};try{await api(id?`/api/invoices/${id}`:'/api/invoices',{method:id?'PUT':'POST',body:JSON.stringify(payload)});closeModal('invoiceModal');await loadAll();toast(id?'Invoice updated':'Invoice added');}catch(err){toast(err.message)}});
  $('approveDraftBtn').addEventListener('click',async()=>{try{await api(`/api/invoices/${activeInvoiceId}/followup`,{method:'POST',body:JSON.stringify({subject:$('followupSubject').value,body:$('followupText').value})});closeModal('followupModal');await loadAll();toast('Follow-up queued in server outbox');}catch(e){toast(e.message)}});
  $('copyDraftBtn').addEventListener('click',async()=>{const text=`Subject: ${$('followupSubject').value}\n\n${$('followupText').value}`;try{await navigator.clipboard.writeText(text);toast('Draft copied')}catch{toast('Copy blocked in this browser')}});
  $('analyzeReplyBtn').addEventListener('click',async()=>{const text=$('replyText').value.trim();if(!text)return toast('Enter a reply first');try{const r=await api(`/api/invoices/${activeInvoiceId}/reply`,{method:'POST',body:JSON.stringify({text})});closeModal('replyModal');await loadAll();const label=r.analysis.type==='promised'?`promise for ${r.analysis.date}`:r.analysis.type;toast(`Detected: ${label}`);}catch(e){toast(e.message)}});
  $('saveSettings').addEventListener('click',async()=>{try{state.settings=await api('/api/settings',{method:'PUT',body:JSON.stringify({business:$('settingsBusiness').value.trim(),sender:$('settingsSender').value.trim(),tone:$('settingsTone').value,currency:$('settingsCurrency').value})});await loadAll();toast('Settings saved')}catch(e){toast(e.message)}});
  $('exportData').addEventListener('click',async()=>{try{const data=await api('/api/export');const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='duemind-account-export.json';a.click();URL.revokeObjectURL(url);toast('Account data exported')}catch(e){toast(e.message)}});
  $('resetData').addEventListener('click',async()=>{if(!confirm('Reset demo invoices and templates for this account?'))return;try{await api('/api/reset',{method:'POST',body:'{}'});await loadAll();toast('Demo data reset')}catch(e){toast(e.message)}});
  $('resetTemplates').addEventListener('click',async()=>{try{state.templates=await api('/api/templates/reset',{method:'POST',body:'{}'});renderTemplates();toast('Templates reset')}catch(e){toast(e.message)}});
  let templateTimer; $('templateGrid').addEventListener('input',e=>{if(!e.target.dataset.template)return;state.templates[e.target.dataset.template]=e.target.value;clearTimeout(templateTimer);templateTimer=setTimeout(async()=>{try{state.templates=await api('/api/templates',{method:'PUT',body:JSON.stringify(state.templates)});toast('Templates saved')}catch(err){toast(err.message)}},700)});
  $('invoiceSearch').addEventListener('input',renderInvoices);$('invoiceFilter').addEventListener('change',renderInvoices);

  document.addEventListener('click',async e=>{
    const close=e.target.closest('[data-close]');if(close)return closeModal(close.dataset.close);
    const scroll=e.target.closest('[data-scroll]');if(scroll){document.getElementById(scroll.dataset.scroll)?.scrollIntoView({behavior:'smooth'});return}
    const side=e.target.closest('[data-view]');if(side)return switchView(side.dataset.view);
    const draft=e.target.closest('[data-draft]');if(draft)return openDraft(draft.dataset.draft);
    const reply=e.target.closest('[data-reply]');if(reply)return openReply(reply.dataset.reply);
    const paid=e.target.closest('[data-paid]');if(paid){try{await api(`/api/invoices/${paid.dataset.paid}/paid`,{method:'POST',body:'{}'});await loadAll();toast('Invoice marked paid')}catch(err){toast(err.message)}return}
    const edit=e.target.closest('[data-edit]');if(edit)return openInvoice(state.invoices.find(i=>i.id===edit.dataset.edit));
    const del=e.target.closest('[data-delete]');if(del){const inv=state.invoices.find(i=>i.id===del.dataset.delete);if(inv&&confirm(`Delete ${inv.number}?`)){try{await api(`/api/invoices/${inv.id}`,{method:'DELETE'});await loadAll();toast('Invoice deleted')}catch(err){toast(err.message)}}return}
  });

  ['startBtn','heroStart','ctaStart'].forEach(id=>$(id).addEventListener('click',()=>requireAuth('signup')));$('loginBtn').addEventListener('click',()=>requireAuth('login'));$('brandHome').addEventListener('click',()=>state.user?showApp():showLanding());$('demoDraftBtn').addEventListener('click',()=>requireAuth('signup'));$('addInvoiceToday').addEventListener('click',()=>openInvoice());$('addInvoiceInvoices').addEventListener('click',()=>openInvoice());
  qsa('.modal-backdrop').forEach(backdrop=>backdrop.addEventListener('click',e=>{if(e.target===backdrop)closeModal(backdrop.id)}));document.addEventListener('keydown',e=>{if(e.key==='Escape')qsa('.modal-backdrop:not(.hidden)').forEach(m=>closeModal(m.id))});
  boot();
})();
