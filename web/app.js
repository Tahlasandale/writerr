/* Writer Deck — logique d'édition et interface.
   Dépend de lib.js (globals purs) et de config.js (window.WD_CONFIG).
   Corps déplacé tel quel depuis l'ancien <script> inline. */
const $=s=>document.querySelector(s),ed=$('#ed');
const ld=(k,d)=>{try{const v=localStorage.getItem(k);return v==null?d:JSON.parse(v)}catch(e){return d}};
const sv=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}};
let docs=[],cur=ld('mwd:cur',null),act=null,saveT,idleT,idleMs=ld('mwd:idle',6000),db=null,ready=false;

/* ---------- IndexedDB (repli localStorage si indisponible) ---------- */
const idb=()=>new Promise(res=>{try{
  const r=indexedDB.open('writer-deck',1);
  r.onupgradeneeded=()=>r.result.createObjectStore('docs',{keyPath:'id'});
  r.onsuccess=()=>res(r.result);r.onerror=r.onblocked=()=>res(null);
}catch(e){res(null)}});
const tx=(mode,f)=>new Promise(res=>{try{
  const t=db.transaction('docs',mode),q=f(t.objectStore('docs'));
  t.oncomplete=()=>res(q&&q.result);t.onerror=t.onabort=()=>res(null);
}catch(e){res(null)}});
const dbAll=()=>tx('readonly',s=>s.getAll());
const dbPut=d=>db?tx('readwrite',s=>s.put(JSON.parse(JSON.stringify(d)))):Promise.resolve(sv('mwd:docs',docs));
const dbDel=id=>db?tx('readwrite',s=>s.delete(id)):Promise.resolve(sv('mwd:docs',docs));

/* ---------- Rendu WYSIWYG par ligne ---------- */
function render(l,raw){
  if(raw==null)raw=l.textContent;const r=html(raw);
  l.className='l '+r.cls+(l===act?' act':'');l.style.setProperty('--i',r.ind+'ch');l.innerHTML=r.h;
}
function mk(raw){const d=document.createElement('div');render(d,raw);return d}
const getLine=n=>{while(n&&n!==ed){if(n.parentNode===ed)return n;n=n.parentNode}return null};
function off(l){const s=getSelection();if(!s.rangeCount)return 0;const r=s.getRangeAt(0).cloneRange();r.selectNodeContents(l);r.setEnd(s.anchorNode,s.anchorOffset);return r.toString().length}
function put(l,o){const w=document.createTreeWalker(l,4),r=document.createRange();let n,c=0;
  const go=()=>{const s=getSelection();s.removeAllRanges();s.addRange(r)};
  while(n=w.nextNode()){if(c+n.length>=o){r.setStart(n,o-c);r.collapse(true);return go()}c+=n.length}
  r.selectNodeContents(l);r.collapse(false);go()}
const text=()=>[...ed.children].map(l=>l.textContent).join('\n');

function fix(){
  [...ed.childNodes].forEach(c=>{if(c.nodeType==3||c.tagName!='DIV'||!c.classList.contains('l')){const d=document.createElement('div');c.replaceWith(d);render(d,c.textContent)}});
  if(!ed.firstChild)ed.appendChild(mk(''));
}
ed.addEventListener('input',e=>{
  if(e.isComposing)return;fix();
  const s=getSelection(),l=s.anchorNode&&getLine(s.anchorNode);
  if(l){const o=off(l);render(l);put(l,o)}
  changed();upd(true);
});
ed.addEventListener('compositionend',()=>ed.dispatchEvent(new Event('input')));
function split(cont){
  const s=getSelection();if(!s.rangeCount)return;
  if(!s.isCollapsed)document.execCommand('delete');
  const l=getLine(s.anchorNode);if(!l)return;
  const raw=l.textContent,o=off(l),before=raw.slice(0,o),after=raw.slice(o);
  const auto=cont!==false;/* collage : on recopie le texte tel quel, sans prolonger la liste */
  const li=before.match(/^( *)(- \[[ xX]\] |[-*] |\d+\. )/);
  if(auto&&li&&before.length==li[0].length&&!after){render(l,'');put(l,0);changed();return}
  const qm=before.match(/^( *)> ?$/);/* citation vide -> on sort de la citation */
  if(auto&&qm&&!after){render(l,qm[1]);put(l,qm[1].length);changed();return}
  let pre='';
  if(li)pre=auto?(li[1]+(/^\d/.test(li[2])?(parseInt(li[2])+1)+'. ':li[2][2]=='['?'- [ ] ':li[2])):'';
  else if(auto&&/^> /.test(before)&&before.length>2)pre='> ';
  render(l,before);const n=mk(pre+after);l.after(n);put(n,pre.length);
  n.scrollIntoView({block:'nearest'});changed();
}
const pasteBreak=()=>split(false);
ed.addEventListener('keydown',e=>{
  if(!sl.hidden&&!e.isComposing){
    if(e.key=='ArrowDown'||e.key=='ArrowUp'){e.preventDefault();sel(idx+(e.key=='ArrowDown'?1:-1));return}
    if(e.key=='Enter'||e.key=='Tab'){e.preventDefault();apply(cmds[idx]);return}
    if(e.key=='Escape'){e.preventDefault();const t=tok();dis=t&&{l:t.l,st:t.st};close();return}
  }
  if(e.key=='Enter'&&!e.isComposing){e.preventDefault();split();return}
  if(e.key=='Tab'){
    const s=getSelection(),l=s.anchorNode&&getLine(s.anchorNode);
    if(l&&/^ *(- \[[ xX]\] |[-*] |\d+\. )/.test(l.textContent)){
      e.preventDefault();const raw=l.textContent,o=off(l);let n=raw,d=0;
      if(e.shiftKey){if(/^  /.test(raw)){n=raw.slice(2);d=-2}}else{n='  '+raw;d=2}
      render(l,n);put(l,Math.max(0,o+d));changed();
    }
  }
});
const cbox=e=>{const g=e.target.closest&&e.target.closest('[data-c]');if(!g)return null;const l=getLine(g);return l||g};
ed.addEventListener('pointerdown',e=>{
  const l=cbox(e);if(!l)return;e.preventDefault();
  const on=l===act,o=on?off(l):0;
  render(l,l.textContent.replace(/^( *- \[)([ xX])(\] )/,(m,a,c,b)=>a+(c==' '?'x':' ')+b));
  if(on)put(l,o);changed();
});
['mousedown','click'].forEach(t=>ed.addEventListener(t,e=>{if(cbox(e))e.preventDefault()}));
ed.addEventListener('paste',e=>{
  e.preventDefault();
  (e.clipboardData.getData('text/plain')||'').replace(/\r/g,'').split('\n').forEach((t,i)=>{if(i)pasteBreak();if(t)document.execCommand('insertText',false,t)});
});
/* ---------- Slash commands ---------- */
const sl=$('#sl');let cmds=[],idx=0,dis=null;
const CMD=[
  {n:'Texte',k:'text paragraphe',i:'¶',h:'',p:''},
  {n:'Titre 1',k:'h1 titre heading',i:'H1',h:'#',p:'# '},
  {n:'Titre 2',k:'h2 titre heading',i:'H2',h:'##',p:'## '},
  {n:'Titre 3',k:'h3 titre heading',i:'H3',h:'###',p:'### '},
  {n:'Liste à puces',k:'ul puce bullet liste',i:'•',h:'-',p:'- '},
  {n:'Liste numérotée',k:'ol numero liste',i:'1.',h:'1.',p:'1. '},
  {n:'Case à cocher',k:'todo tache checkbox task',i:'☐',h:'[ ]',p:'- [ ] '},
  {n:'Citation',k:'quote',i:'❝',h:'>',p:'> '},
  {n:'Séparateur',k:'divider hr ligne',i:'—',h:'---',t:'hr'},
  {n:'Gras',k:'bold',i:'B',h:'**',t:'in',s:'**'},
  {n:'Italique',k:'italic',i:'I',h:'*',t:'in',s:'*'},
  {n:'Date du jour',k:'date today',i:'D',h:'',t:'date'}
];
function tok(){
  const s=getSelection();if(!s.rangeCount||!s.isCollapsed)return null;
  const l=s.anchorNode&&getLine(s.anchorNode);if(!l)return null;
  const o=off(l),m=l.textContent.slice(0,o).match(/(^|\s)\/([^\s\/]{0,20})$/);
  return m?{l,o,q:m[2],st:o-m[2].length-1}:null;
}
function upd(){
  const t=tok();if(!t||(dis&&dis.l===t.l&&dis.st===t.st)){close();return}
  const q=norm(t.q);cmds=CMD.filter(c=>!q||norm(c.n+' '+c.k).includes(q));
  if(!cmds.length){close();return}
  idx=0;sl.innerHTML=cmds.map((c,i)=>'<button role="option" data-i="'+i+'"'+(i?'':' aria-selected="true"')+'><b class="ic">'+c.i+'</b><span>'+c.n+'</span><em>'+c.h+'</em></button>').join('');
  sl.hidden=false;place();
}
function close(){sl.hidden=true}
function sel(i){
  idx=(i+cmds.length)%cmds.length;
  [...sl.children].forEach((b,j)=>{b.setAttribute('aria-selected',j==idx);if(j==idx)b.scrollIntoView({block:'nearest'})});
}
function place(){
  const s=getSelection();if(!s.rangeCount)return;
  const l=getLine(s.anchorNode);if(!l)return;
  const r=s.getRangeAt(0).getClientRects()[0]||l.getBoundingClientRect();
  const v=window.visualViewport,vt=v?v.offsetTop:0,vh=v?v.height:innerHeight,vl=v?v.offsetLeft:0,vw=v?v.width:innerWidth;
  const dn=vt+vh-r.bottom-12,up=r.top-vt-12,below=dn>=Math.min(sl.scrollHeight,200)||dn>=up;
  sl.style.maxHeight=Math.max(120,Math.min(300,below?dn:up))+'px';
  sl.style.top=(below?r.bottom+6:r.top-sl.offsetHeight-6)+'px';
  sl.style.left=Math.max(vl+8,Math.min(r.left,vl+vw-sl.offsetWidth-8))+'px';
}
function apply(c){
  const t=tok();close();if(!c||!t)return;
  const{l,o,st}=t,raw=l.textContent,base=raw.slice(0,st)+raw.slice(o);
  if(c.t=='in'){render(l,raw.slice(0,st)+c.s+c.s+raw.slice(o));put(l,st+c.s.length)}
  else if(c.t=='date'){const d=new Date().toLocaleDateString('fr-FR',{day:'numeric',month:'long',year:'numeric'});render(l,raw.slice(0,st)+d+raw.slice(o));put(l,st+d.length)}
  else if(c.t=='hr'){
    const e=!base.trim(),h=e?l:mk('---');
    if(e)render(l,'---');else{render(l,base.replace(/[ \t]+$/,''));l.after(h)}
    const n=mk('');h.after(n);put(n,0);n.scrollIntoView({block:'nearest'});
  }else{
    const head=base.replace(/[ \t]+$/,'');/* l'espace saisi avant "/" n'est pas un séparateur de plus */
    const m=head.match(/^( *)(#{1,3} |> |- \[[ xX]\] |[-*] |\d+\. )/),sp=m?m[0].length:0;
    render(l,c.p+head.slice(sp));put(l,c.p.length+Math.max(0,Math.min(st,head.length)-sp));
  }
  changed();
}
sl.addEventListener('mousedown',e=>e.preventDefault());
sl.addEventListener('mousemove',e=>{const b=e.target.closest('button');if(b&&+b.dataset.i!==idx)sel(+b.dataset.i)});
sl.addEventListener('click',e=>{const b=e.target.closest('button');if(b)apply(cmds[+b.dataset.i])});
$('#bSl').addEventListener('mousedown',e=>e.preventDefault());
$('#bSl').onclick=()=>{
  const s=getSelection();let l=s.rangeCount&&s.anchorNode&&getLine(s.anchorNode);
  if(!l){ed.focus();l=ed.lastElementChild;if(!l)return;put(l,l.textContent.length)}/* avant le 1er rendu : aucune ligne */
  const p=l.textContent[off(l)-1];
  document.execCommand('insertText',false,(!p||/\s/.test(p)?'':' ')+'/');
};
$('#scroll').addEventListener('scroll',()=>{if(!sl.hidden)place()},{passive:true});
if(window.visualViewport)visualViewport.addEventListener('resize',()=>{if(!sl.hidden)place()});

document.addEventListener('selectionchange',()=>{
  const s=getSelection(),l=s.anchorNode&&ed.contains(s.anchorNode)?getLine(s.anchorNode):null;
  if(l!==act){act&&act.classList.remove('act');act=l;l&&l.classList.add('act')}
  const t=tok();
  if(dis&&(!t||t.l!==dis.l||t.st!==dis.st))dis=null;/* le menu réapparaît dès qu'on quitte la commande ignorée */
  if(!sl.hidden&&!t)close();
});

/* ---------- Backend desktop (Tauri) ou IndexedDB (PWA) ---------- */
/* Le backend est choisi à l'exécution : window.__TAURI__ présent ou non (invariant I2).
   TauriAdapter ne mappe QUE les commandes Rust de §5.11 ; aucun accès FS direct. */
function isDesktop(){return !!window.__TAURI__}
function invoke(cmd,args){return window.__TAURI__.core.invoke(cmd,args)}
const IS_DESKTOP=isDesktop();
/* mtime connu de l'editor vs mtime sur disque : l'entrée de `reconcile` (§5.9) */

function TauriAdapter(){
  this.kind='tauri';
  this.supportsFolders=true;
  this._sub=null;
}
TauriAdapter.prototype.init=function(){
  const self=this;
  return this.get_config().then(cfg=>{
    self.config=cfg;
    if(!cfg.root){self.root=null;return null}
    self.root=cfg.root;
    return self._listen();
  });
};
TauriAdapter.prototype._listen=function(){
  const self=this;
  const h=window.__TAURI__.event;
  const p1=h.listen('tree-changed',()=>{reindexTree();list()});
  const p2=h.listen('note-changed',e=>{
    const id=toId(e.payload[0]);
    const mt=e.payload[1];
    diskMtime[id]=mt;
    const r=reconcile({dirty:changedSinceOpen.has(id),knownMtime:knownMtime[id],diskMtime:mt});
    if(r==='reload')open(id);
    else if(r==='conflict')showConflict(id);
  });
  return Promise.all([p1,p2]).then(r=>{self._sub=()=>{r.forEach(f=>f&&f())}}).then(()=>self.refresh());
};
TauriAdapter.prototype.onExternalChange=function(cb){this._cb=cb;return ()=>{this._cb=null}};
TauriAdapter.prototype.refresh=function(){return this.list_tree().then(t=>{self_tree=t;return t})};
/* Chaque methode du contrat appelle la commande Rust du meme nom (§5.11). */
['get_config','set_config','list_tree','create_dir','app_version'].forEach(k=>{
  TauriAdapter.prototype[k]=function(){return invoke(k)};
});
TauriAdapter.prototype.read=function(id){return invoke('read_note',{rel:toPath(id)})};
TauriAdapter.prototype.write=function(id,content){return invoke('write_note',{rel:toPath(id),content}).then(r=>{knownMtime[id]=r.mtime;return r})};
TauriAdapter.prototype.create=function(dirId,title){return invoke('create_note',{dir:toPath(dirId||''),title})};
TauriAdapter.prototype.rename=function(id,newTitle){return invoke('rename',{rel:toPath(id),toTitle:newTitle})};
TauriAdapter.prototype.remove=function(id){return invoke('delete',{rel:toPath(id)})};
TauriAdapter.prototype.pickRoot=function(){return invoke('pick_root',{}).then(r=>{this.root=r.data;return this.list_tree()})};
/* id (web) <-> chemin relatif (desktop) : même valeur, deux traitements */
const toPath=id=>String(id==null?'':id).replace(/\\/g,'/');
const toId=rel=>String(rel==null?'':rel).replace(/\\/g,'/');
let self_tree=[];
const changedSinceOpen=new Set();

/* L'écran « choisir un dossier » n'existe qu'en desktop : la PWA n'a pas de FS. */
function pickRootUI(){
  if(!IS_DESKTOP){$('#saved').textContent='disponible uniquement en version bureau';return}
  invoke('pick_root',{}).then(r=>{
    document.body.removeAttribute('data-noroot');
    store.root=r.data;
    return store.list_tree();
  }).then(t=>{self_tree=t;list();buildTree()}).catch(()=>{
    $('#saved').textContent='choix annulé';
  });
}

/* ---------- Documents & persistance ---------- */
/* `docs` est la liste EN MÉMOIRE des métadonnées (§6.2) : elle existe aussi en
   desktop, où elle est reconstruite depuis l'arborescence. Sans elle, doc()
   renverrait null et save() n'écrirait jamais le .md. */
const doc=()=>docs.find(d=>String(d.id)===String(cur));
function syncDocsFromTree(){
  const out=[];
  const walk=ns=>ns.forEach(n=>{
    if(n.is_dir){walk(n.children||[]);return}
    const id=toRel(n.path);
    const known=docs.find(d=>String(d.id)===id);
    out.push(known||{id:id,title:nameOf(n),content:'',createdAt:n.created||n.modified||0,
                     updatedAt:n.modified||0,wordCount:0,readingTime:0});
  });
  walk(self_tree);
  if(cur&&!out.some(d=>String(d.id)===String(cur))){
    const n=findNode(cur);
    if(n)out.push({id:toRel(n.path),title:nameOf(n),content:'',createdAt:n.created||0,
                   updatedAt:n.modified||0,wordCount:0,readingTime:0});
  }
  docs=out;
}
function changed(){
  $('#saved').textContent='…';clearTimeout(saveT);saveT=setTimeout(save,300);
  const s=stats(text());$('#stats').textContent=s.w+' mot'+(s.w>1?'s':'')+' · '+s.r+' min';
  clearTimeout(tocT);tocT=setTimeout(buildToc,250);
}
function save(){
  if(!ready)return;const d=doc();if(!d)return;const t=text(),s=stats(t);
  Object.assign(d,{content:t,updatedAt:Date.now(),wordCount:s.w,readingTime:s.r});
  indexUpsert(d);changedSinceOpen.add(cur);
  /* Desktop : le .md est la source de vérité (écriture atomique côté Rust) ;
     PWA : IndexedDB, avec repli localStorage inchangé. */
  if(store&&store.supportsFolders){
    store.write(cur,t).then(r=>{
      knownMtime[cur]=r.mtime;diskMtime[cur]=r.mtime;
      changedSinceOpen.delete(cur);
      $('#saved').textContent='enregistré';
    }).catch(e=>{$('#saved').textContent='échec : '+((e&&e.message)||e)});
    return;
  }
  sv('mwd:cur',cur);dbPut(d).then(()=>{$('#saved').textContent='enregistré'});
}
function open(id){
  if(doc())save();cur=id;
  const paint=(title,content,mtime)=>{
    ed.innerHTML='';act=null;String(content||'').split('\n').forEach(t=>ed.appendChild(mk(t)));
    $('#scroll').scrollTop=0;
    $('#title').value=title||'';
    if(mtime!=null){knownMtime[id]=mtime;diskMtime[id]=mtime}
    changedSinceOpen.delete(id);
    ready=true;changed();sv('mwd:cur',cur);list();
  };
  /* Desktop : le contenu est lu à l'ouverture (§6.2) ; PWA : déjà en mémoire. */
  if(store&&store.supportsFolders){
    const d=doc();
    /* Titre = nom du fichier SANS extension (invariant I6 : titre = nom de fichier).
       On le capture AVANT le premier paint() : celui-ci vide #title, donc relire
       $('#title').value ensuite renverrait une chaîne vide. */
    const title=d?d.title:nameOf(findNode(id));
    paint(title,'',null);
    return store.read(id).then(r=>{
      if(String(cur)!==String(id))return;/* l'utilisateur a changé d'avis */
      paint(title,r.content,r.mtime);
      const s=stats(r.content||'');
      const d2=doc();
      if(d2){d2.content=r.content;d2.wordCount=s.w;d2.readingTime=s.r;d2.updatedAt=r.mtime||d2.updatedAt}
      indexUpsert({id:String(id),title:title,content:r.content,updatedAt:r.mtime});
    }).catch(()=>{});
  }
  const d=doc();paint(d.title,d.content,d.updatedAt);
}
function create(title,content){
  const n=Date.now(),d={id:uid(),title:title||'',content:content||'',createdAt:n,updatedAt:n,wordCount:0,readingTime:0};
  docs.unshift(d);dbPut(d);indexUpsert(d);return d;
}
/* Modifications externes (desktop) : bandeau discret, jamais de fusion (spec §12.5) */

function showConflict(id){
  const c=$('#conflict');if(!c)return;
  c.hidden=false;c.innerHTML='';
  const mk=(t,f)=>{const b=document.createElement('button');b.textContent=t;b.onclick=f;c.appendChild(b)};
  mk('Modifié ailleurs',()=>{const r=reconcile({dirty:true,knownMtime:knownMtime[id],diskMtime:diskMtime[id]});
    if(r==='reload')open(id);c.hidden=true});
  mk('Recharger',()=>{open(id);c.hidden=true});
  mk('Garder',()=>{diskMtime[id]=knownMtime[id];c.hidden=true});
}
const knownMtime={},diskMtime={};
/* ---------- Tri, recherche, arborescence ---------- */
let sortSpec={key:'modified',dir:'desc'};
const readSort=()=>{const s=ld('mwd:sort',null);if(s&&s.key)sortSpec={key:s.key,dir:s.dir||'desc'}};
const nodeOf=d=>({id:d.id,name:d.title||'Sans titre',title:d.title||'Sans titre',is_dir:false,
                  modified:d.updatedAt||0,created:d.createdAt||d.updatedAt||0,
                  size:stats(d.content||'').bytes,children:[]});
const SearchIndex=(window.WDSEARCH||{}).SearchIndex;
let search=null,store=null;

/* En desktop, #list affiche l'ARBORESCENCE du dossier de notes (§6.4).
   En PWA, la liste plate est exactement celle d'avant : `list()` est inchangée. */
function list(){
  const L=$('#list');L.innerHTML='';
  if(store&&store.supportsFolders){buildTree();return}
  const sorted=sortNodes(docs.map(nodeOf),sortSpec);
  sorted.forEach(n=>{
    const d=docs.find(z=>z.id==n.id);if(!d)return;
    const r=document.createElement('div');r.className='row';
    const b=document.createElement('button');b.className='doc'+(d.id==cur?' cur':'');
    b.innerHTML=esc(d.title||'Sans titre')+'<small>'+d.wordCount+' m</small>';
    b.__id=d.id;/* exposé pour les tests et le débogage */
    b.onclick=()=>{open(d.id);panel()};
    const x=document.createElement('button');x.className='ib';x.textContent='×';x.style.width='32px';
    x.onclick=()=>{
      if(x.dataset.s!='1'){x.dataset.s='1';x.textContent='sûr ?';x.style.width='auto';return}
      docs=docs.filter(z=>z!=d);
      if(search)search.remove(d.id);
      if(store&&store.supportsFolders){
        store.remove(d.id).then(()=>store.list_tree()).then(t=>{
          self_tree=t;list();
          if(String(d.id)===String(cur)){cur=null;const f=firstNoteId();if(f)open(f)}
        }).catch(e=>{$('#saved').textContent='échec : '+((e&&e.message)||e)});
        return;
      }
      if(!docs.length)create('','');
      dbDel(d.id);if(d.id==cur){cur=null;open(docs[0].id)}else{reindex();list()}
    };
    r.append(b,x);L.appendChild(r);
  });
}
function reindex(){
  if(!search)return;
  docs.forEach(d=>search.update({id:d.id,title:d.title,content:d.content||'',updatedAt:d.updatedAt||0}));
}
/* Mise à jour ciblée : la recherche doit voir les documents dès leur création,
   leur renommage et chaque frappe — sans reconstruire l'index à chaque fois. */
function indexUpsert(d){
  if(!search||!d)return;
  search.update({id:d.id,title:d.title,content:d.content||'',updatedAt:d.updatedAt||0});
}
function runSearch(){
  const q=$('#q').value.trim();
  const R=$('#results'),L=$('#list');
  if(!q){R.hidden=true;R.innerHTML='';L.hidden=false;return}
  if(!search){R.hidden=false;L.hidden=true;R.innerHTML='<p class="empty">Index en cours…</p>';return}
  const hits=search.query(q,{limit:30});
  R.hidden=false;L.hidden=true;
  if(!hits.length){R.innerHTML='<p class="empty">Aucun résultat.</p>';return}
  R.innerHTML='';
  hits.forEach(h=>{
    const b=document.createElement('button');
    b.className='res'+(h.id==cur?' cur':'');
    b.innerHTML='<b>'+esc(h.title||'Sans titre')+'</b><span>'+esc(h.snippet||'')+'</span>';
    b.onclick=()=>{open(h.id);panel()};
    R.appendChild(b);
  });
}
/* ---------- Arborescence (desktop uniquement, §6.4) ---------- */
const fold=new Set();
const readFold=()=>{const f=ld('mwd:fold',null);if(Array.isArray(f))f.forEach(x=>fold.add(x))};
function buildTree(){
  const L=$('#list');if(!L)return;
  L.innerHTML='';
  const roots=sortNodes(self_tree.length?self_tree:docs.map(nodeOf),sortSpec);
  const walk=(nodes,depth)=>{
    nodes.forEach(n=>{
      const id=toRel(n.path);
      if(n.is_dir){
        const d=document.createElement('div');d.className='row';
        const b=document.createElement('button');b.className='tree-l';
        const open=!fold.has(id);
        b.innerHTML='<span class="tw">'+(open?'▾':'▸')+'</span><span class="nm">'+esc(n.name)+'</span>';
        b.style.paddingLeft=(8+depth*14)+'px';
        b.onclick=()=>{open?fold.add(id):fold.delete(id);sv('mwd:fold',[...fold]);list()};
        d.appendChild(b);
        const x=document.createElement('button');x.className='ib';x.textContent='×';x.style.width='28px';
        x.onclick=()=>{
          if(x.dataset.s!='1'){x.dataset.s='1';x.textContent='sûr ?';x.style.width='auto';return}
          store.remove(id).then(()=>store.list_tree()).then(t=>{self_tree=t;list()});
        };
        d.append(x);L.appendChild(d);
        if(open)walk(sortNodes(n.children||[],sortSpec),depth+1);
        return;
      }
      const r=document.createElement('div');r.className='row';
      const b=document.createElement('button');
      b.className='tree-l'+(toRel(n.path)===cur?' cur':'');
      b.innerHTML='<span class="tw"></span><span class="nm">'+esc(nameOf(n))+'</span><small>'+n.mtimeLabel+'</small>';
      b.style.paddingLeft=(8+depth*14)+'px';
      b.__id=toRel(n.path);
      b.onclick=()=>{open(toRel(n.path));panel()};
      r.appendChild(b);L.appendChild(r);
    });
  };
  /* mtime lisible : la spec expose des ms epoch, l'interface veut « il y a 3 j ». */
  const stamp=ms=>{
    const d=Date.now()-ms;
    if(d<60000)return"à l'instant";
    if(d<3600000)return Math.floor(d/60000)+' min';
    if(d<86400000)return Math.floor(d/3600000)+' h';
    if(d<604800000)return Math.floor(d/86400000)+' j';
    return new Date(ms).toLocaleDateString('fr-FR');
  };
  roots.forEach(r=>{r.mtimeLabel=stamp(r.modified||0)});
  const mark=(nodes)=>nodes.forEach(n=>{mark(n.children||[]);n.mtimeLabel=stamp(n.modified||0)});
  mark(roots);
  walk(roots,0);
}
/* Tri de l'arborescence : `mtimeLabel` est calculé par buildTree, pas par sortNodes. */

/* Masque les tris impossibles en PWA (pas de taille ni d'extension calculées) */
/* Le <select> encode key:dir, mais le sens est aussi porté par #sortdir : on
   positionne l'option par KEY seulement, sinon value='' quand le sens stocké
   diffère du sens par défaut de l'option. */
function applySortUI(){
  const s=$('#sort');
  const avail=[...s.options].filter(o=>!o.dataset.fs||fsCapable);
  if(!avail.some(o=>o.value.split(':')[0]===sortSpec.key)){
    const fb=avail.find(o=>o.value.split(':')[0]==='modified')||avail[0];
    if(fb)sortSpec={key:fb.value.split(':')[0],dir:sortSpec.dir};
  }
  const o=avail.find(x=>x.value.split(':')[0]===sortSpec.key);
  if(o)s.value=o.value;
  $('#sortdir').textContent=sortSpec.dir==='asc'?'↑':'↓';
}
let fsCapable=false;/* PWA : taille/extension indisponibles (l'adaptateur FS les fournira) */
$('#sort').addEventListener('change',e=>{
  const [k,d]=e.target.value.split(':');
  sortSpec={key:k,dir:d||'desc'};sv('mwd:sort',sortSpec);applySortUI();list();
});
$('#sortdir').onclick=()=>{
  sortSpec={key:sortSpec.key,dir:sortSpec.dir==='asc'?'desc':'asc'};
  sv('mwd:sort',sortSpec);applySortUI();list();
};
$('#q').addEventListener('input',runSearch);
$('#q').addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();$('#q').value='';runSearch()}});
/* Import d'un dossier de .md : chaque fichier devient un document, les sous-dossiers
   deviennent « Dossier / fichier ». Un seul tour, sans surveillance. */
$('#bImpDir').onclick=()=>$('#folderInput').click();
$('#folderInput').onchange=e=>{
  /* Le bouton annonce « un dossier de .md » : on ne prend donc QUE les .md.
     Les .txt du dossier sont ignorés (l'import .txt unitaire reste disponible). */
  const files=[...e.target.files].filter(f=>/\.md$/i.test(f.name));
  e.target.value='';
  if(!files.length){$('#saved').textContent='aucun .md trouvé';return}
  save();
  let pending=files.length,last=null;
  files.forEach(f=>{
    const r=new FileReader();
    r.onload=()=>{
      const rel=(f.webkitRelativePath||f.name).split('/').filter(Boolean);
      rel.shift();/* le dossier racine choisi n'est pas dans le titre */
      const name=f.name.replace(/\.md$/i,'');
      /* rel = le chemin APRÈS le dossier racine (racine retirée) : s'il reste des
   segments, ce sont des sous-dossiers → « Sous / deep ». Sinon le nom seul. */
      const title=rel.length>1?rel.slice(0,-1).join(' / ')+' / '+name:name;
      const d=create(title,String(r.result||'').replace(/\r/g,''));
      const s=stats(d.content);
      d.wordCount=s.w;d.readingTime=s.r;
      /* Le contenu arrive APRÈS create() : on réindexe avec le texte complet,
         sinon le document importé resterait introuvable par la recherche. */
      indexUpsert(d);
      dbPut(d).then(()=>{if(--pending)return;reindex();list();open(last.id);panel()});
      last=d;
    };
    r.readAsText(f);
  });
};
/* Renommage : PWA = titre libre ; desktop = renommage du FICHIER, debounce 800 ms
   (§6.3), jamais pendant la frappe d'un caractère composé. */
let renameT;
$('#title').addEventListener('input',e=>{
  const d=doc();if(!d)return;
  d.title=e.target.value.slice(0,255);
  indexUpsert(d);changed();
  if(!(store&&store.supportsFolders)){list();return}
  clearTimeout(renameT);
  const id=cur;
  renameT=setTimeout(()=>{
    if(e.isComposing)return;
    store.rename(id,$('#title').value).then(r=>{
      cur=String(r.id);d.id=String(r.id);
      sv('mwd:cur',cur);
      return store.list_tree();
    }).then(t=>{self_tree=t;list()})
      .catch(err=>{$('#saved').textContent='échec : '+((err&&err.message)||err)});
  },800);
});
$('#bNew').onclick=()=>{
  if(doc())save();
  if(store&&store.supportsFolders){
    const dir=cur&&cur.includes('/')?cur.slice(0,cur.lastIndexOf('/')):'';
    store.create(dir,'Sans titre').then(r=>{
      return store.list_tree().then(t=>{self_tree=t;list();return r.id});
    }).then(id=>{open(String(id));panel();ed.focus()}).catch(e=>{$('#saved').textContent='échec : '+((e&&e.message)||e)});
    return;
  }
  const d=create('','');open(d.id);panel();ed.focus();
};
/* Dossier : desktop uniquement (§6.4) */
$('#bNewDir').onclick=()=>{
  if(!store||!store.supportsFolders){$('#saved').textContent='disponible uniquement en version bureau';return}
  const dir=cur&&cur.includes('/')?cur.slice(0,cur.lastIndexOf('/')):'';
  store.create_dir(dir).then(r=>store.list_tree()).then(t=>{self_tree=t;list()})
    .catch(e=>{$('#saved').textContent='échec : '+((e&&e.message)||e)});
};

/* ---------- Plan (ToC) ---------- */
let tocT;
function buildToc(){
  const T=$('#tocList'),ls=[...ed.children],hs=[];
  ls.forEach((l,i)=>{const m=l.className.match(/h([123])/);if(m)hs.push({i,lv:+m[1],t:l.textContent.replace(/^#+ /,''),w:0})});
  hs.forEach((h,k)=>{const end=k+1<hs.length?hs[k+1].i:ls.length;for(let j=h.i+1;j<end;j++)h.w+=ls[j].textContent.trim().split(/\s+/).filter(Boolean).length});
  T.innerHTML=hs.length?'':'<p class="empty">Ajoutez des titres avec #, ## ou ###.</p>';
  hs.forEach(h=>{
    const b=document.createElement('button');b.className='t';
    b.innerHTML='<span class="bar" style="width:'+[100,70,45][h.lv-1]+'%;opacity:'+(.3+Math.min(.7,h.w/250)).toFixed(2)+'"></span><span class="lbl">'+esc(h.t||'Sans titre')+' · '+h.w+' m</span>';
    b.onclick=()=>{ls[h.i].scrollIntoView({behavior:'smooth',block:'start'});panel()};
    T.appendChild(b);
  });
}

/* ---------- Panneaux, thème, plein écran, masquage ---------- */
function panel(id){
  ['#docs','#toc','#about'].forEach(s=>$(s).classList.toggle('open',s==id));
  $('#scrim').classList.toggle('on',!!id);poke();
}
$('#bDocs').onclick=()=>{list();panel('#docs')};
$('#bToc').onclick=()=>{buildToc();panel('#toc')};
$('#scrim').onclick=()=>panel();
$('#bTheme').onclick=()=>{
  const r=document.documentElement,dark=r.dataset.theme?r.dataset.theme=='dark':matchMedia('(prefers-color-scheme:dark)').matches;
  r.dataset.theme=dark?'light':'dark';sv('mwd:theme',r.dataset.theme);
};
$('#bFull').onclick=()=>{try{const p=document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen();if(p&&p.catch)p.catch(()=>{})}catch(e){}};
function poke(){
  document.body.classList.remove('idle');clearTimeout(idleT);
  if(idleMs&&!$('#scrim').classList.contains('on'))idleT=setTimeout(()=>document.body.classList.add('idle'),idleMs);
}
['touchstart','keydown','mousemove','input','scroll'].forEach(e=>addEventListener(e,poke,{passive:true,capture:true}));
$('#idle').value=String(idleMs);
$('#idle').onchange=e=>{idleMs=+e.target.value;sv('mwd:idle',idleMs);poke()};

/* ---------- Import / export ---------- */
function dl(name,data,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([data],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
$('#bMd').onclick=()=>{save();const d=doc();dl(slug(d.title)+'.md',d.content,'text/markdown')};
$('#bHtml').onclick=()=>{save();const d=doc();dl(slug(d.title)+'.html',toHtml(d),'text/html')};
$('#bTxt').onclick=()=>{save();const d=doc();dl(slug(d.title)+'.txt',plain(d.content),'text/plain')};
$('#bJson').onclick=()=>{save();dl('writer-deck.json',JSON.stringify(docs,null,1),'application/json')};
async function copy(s){
  try{await navigator.clipboard.writeText(s);$('#saved').textContent='copié';return}catch(e){}
  try{const a=document.createElement('textarea');a.value=s;a.style.cssText='position:fixed;opacity:0';document.body.appendChild(a);a.select();document.execCommand('copy');a.remove();$('#saved').textContent='copié'}catch(e){$('#saved').textContent='copie impossible'}
}
$('#bCopy').onclick=()=>copy(plain(text()));
$('#bCopyMd').onclick=()=>copy(text());
$('#bImp').onclick=()=>$('#file').click();
$('#file').onchange=e=>{
  const f=e.target.files[0];if(!f)return;const r=new FileReader();
  r.onload=()=>{
    save();let last;
    try{
      if(/\.json$/i.test(f.name)){
        [].concat(JSON.parse(r.result)).forEach(o=>{if(o&&typeof o.content=='string'){const d=create(String(o.title||'').slice(0,255),o.content);d.createdAt=o.createdAt||d.createdAt;last=d}})
      }else last=create(f.name.replace(/\.\w+$/,''),r.result.replace(/\r/g,''));
    }catch(x){}
    if(last)open(last.id);panel();e.target.value='';
  };
  r.readAsText(f);
};

/* ---------- Panneau « À propos & téléchargements » ---------- */
const LABEL={repo:'Code source sur GitHub',latest:'Télécharger la dernière version',releases:'Toutes les versions',issues:'Signaler un problème'};
let deferredInstall=null;
addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstall=e});
function isDesktop(){return !!window.__TAURI__}
function openOut(url,disabled){
  if(disabled){$('#saved').textContent='dépôt non configuré';return}
  if(isDesktop()){
    try{invoke('open_external',{url})}catch(_){}
  }else window.open(url,'_blank','noopener noreferrer');
}
/* Un lien du panneau À propos : <a href="…"> pour être réellement cliquable et
   copiable, tout en interceptant le clic pour le desktop (invoke) et la CSP
   (fenêtre externe). Sans interception, Tauri refuse la navigation. */
function link(url,label,disabled){
  const a=document.createElement('a');
  a.href=disabled?'#':url;
  a.target=disabled?null:'_blank';
  if(!disabled)a.rel='noopener noreferrer';
  a.textContent=label;
  if(disabled)a.setAttribute('aria-disabled','true');
  a.onclick=e=>{
    e.preventDefault();
    if(disabled){$('#saved').textContent='dépôt non configuré';return}
    if(isDesktop()){try{invoke('open_external',{url})}catch(_){}}
    else window.open(url,'_blank','noopener noreferrer');
  };
  return a;
}
function buildAbout(){
  const cfg=window.WD_CONFIG||{repo:'',version:'0.0.0'},L=aboutLinks(cfg),C=$('#aboutC');
  C.innerHTML='';
  const h=document.createElement('h4');h.style.marginTop='0';h.textContent='Writer Deck';C.appendChild(h);
  const p=document.createElement('p');p.textContent='Écriture concentrée, sans distraction.';C.appendChild(p);
  const v=document.createElement('p');v.innerHTML='Version <b>'+esc(cfg.version||'—')+'</b>'+(isDesktop()?' (bureau)':' (web)');
  v.style.color='var(--mut)';C.appendChild(v);
  if(L.placeholder){
    const w=document.createElement('p');w.style.color='var(--mut)';
    w.textContent='Dépôt non configuré : renseignez web/config.js.';C.appendChild(w);
  }
  /* Une entrée = un <div> (marge) contenant le <a> ; pour « latest », la phrase
   d'aide est un second <p> DANS ce même div. Si les deux sont des arguments
   séparés de appendChild, le second atterrit à la racine du panneau. */
  const row=t=>{
    const d=document.createElement('div');d.style.margin='10px 0';
    d.appendChild(link(L[t],LABEL[t],L.placeholder));
    if(t==='latest'){
      const s=document.createElement('p');
      s.style.color='var(--mut)';
      s.textContent=assetHint(detectPlatform(navigator.userAgent));
      d.appendChild(s);
    }
    return d;
  };
  ['repo','latest','releases','issues'].forEach(t=>C.appendChild(row(t)));
  if(!isDesktop()){
    const b=document.createElement('button');b.className='act-b';b.textContent="Installer l'application web";
    b.hidden=!deferredInstall;
    b.onclick=()=>{if(deferredInstall){deferredInstall.prompt();deferredInstall=null;b.hidden=true}};
    C.appendChild(b);
  }
  const kh=document.createElement('h5');kh.textContent='Raccourcis';C.appendChild(kh);
  const ul=document.createElement('div');
  [['/', 'commandes'],['Entrée', 'nouvelle ligne / sortie de liste'],['Tab', 'indenter'],['⇧Tab', 'désindenter'],['Échap', 'fermer le menu']].forEach(([k,v])=>{
    const r=document.createElement('div');r.innerHTML='<kbd>'+esc(k)+'</kbd> '+esc(v);ul.appendChild(r);
  });
  C.appendChild(ul);
  const ch=document.createElement('h5');ch.textContent='Commandes « / »';C.appendChild(ch);
  const cl=document.createElement('div');
  CMD.forEach(c=>{const r=document.createElement('div');r.innerHTML='/ <b>'+esc(c.n)+'</b>'+(c.h?' <kbd>'+esc(c.h)+'</kbd>':'');cl.appendChild(r)});
  C.appendChild(cl);
}
$('#bAbout').onclick=()=>{buildAbout();panel('#about')};

/* ---------- Fermeture : sauvegarde avant de quitter (§6.8) ---------- */
if(window.__TAURI__&&window.__TAURI__.window){
  const W=window.__TAURI__.window;
  W.getCurrentWindow().onCloseRequested(async ev=>{
    if(ev&&ev.preventDefault)ev.preventDefault();
    save();
    await new Promise(r=>setTimeout(r,120));
    await W.getCurrentWindow().destroy();
  });
  /* Le desktop n'a pas de « pagehide » fiable : on enregistre aussi sur chaque frappe. */
}

/* ---------- Démarrage ---------- */
{const t=ld('mwd:theme',null);if(t)document.documentElement.dataset.theme=t}
(async()=>{
  store=IS_DESKTOP?new TauriAdapter():new (window.WDSTORE.IdbAdapter)();
  await store.init();
  search=new SearchIndex(norm);
  readSort();applySortUI();readFold();

  if(IS_DESKTOP){
    fsCapable=true;applySortUI();
    /* Les contrôles de dossier n'existent qu'en desktop (I1 : la PWA reste telle quelle) */
    $('#bNewDir').hidden=false;
    [...$('#sort').options].forEach(o=>{if(o.dataset.fs)o.hidden=false});
    if(!store.root){document.body.setAttribute('data-noroot','1');buildNoRoot();return}
    self_tree=await store.list_tree();
    syncDocsFromTree();
    buildIndexFromTree();
    open(cur&&existsId(cur)?cur:firstNoteId());
    return;
  }

  /* PWA : IndexedDB, comportement inchangé */
  db=await idb();
  docs=(db?await dbAll():ld('mwd:docs',[]))||[];
  if(db&&!docs.length){const old=ld('mwd:docs',[]);if(old.length){docs=old;for(const d of old)await dbPut(d)}}
  docs.sort((a,b)=>b.updatedAt-a.updatedAt);
  if(!docs.length)create('Bienvenue','# Bienvenue\n\nÉcrivez ici. Les **marqueurs** disparaissent, le *style* reste.\n\n> Une citation, un doute, une phrase à garder.\n\n## Premier chapitre\n\nTapez / pour ouvrir les commandes. Tout est enregistré sur cet appareil.');
  reindex();
  open(docs.find(d=>d.id==cur)?cur:docs[0].id);
})();
addEventListener('pagehide',save);

/* ---------- Desktop : dossier de notes ---------- */
/* Recherche en profondeur : un nœud peut être imbriqué (Projet/Deep.md). */
function findNode(id){
  const target=String(id==null?'':id);
  let found=null;
  const walk=ns=>{
    for(const n of ns){
      if(found)return true;
      if(toRel(n.path)===target){found=n;return true}
      if(walk(n.children||[]))return true;
    }
    return false;
  };
  walk(self_tree);
  return found;
}
function existsId(id){return !!findNode(id)}
/* Le premier FICHIER de l'arborescence. Rust renvoie `path` (absolu) ; l'id
   côté web est le chemin RELATIF à la racine (invariant I6) : d'où toRel(). */
function firstNoteId(){
  const seen=[];
  const walk=ns=>{
    for(const n of ns){
      seen.push(n);
      if(!n.is_dir)return toRel(n.path);
      if(n.children&&n.children.length){const r=walk(n.children);if(r)return r}
    }
    return null;
  };
  self_firstFile=walk(self_tree);
  return self_firstFile;
}
let self_firstFile=null;
/* Nom affiché d'un nœud : le titre est le nom du fichier moins son extension.
   `n.path` est optionnel : en PWA les nœuds viennent de `nodeOf()` et n'ont pas
   de chemin (le nom EST déjà le titre). */
function nameOf(n){
  if(!n)return '';
  return String(n.name||'').replace(/\.(md|txt)$/i,'');
}
/* /racine/Projet/Deep.md -> Projet/Deep.md ; tolère les séparateurs Windows. */
function toRel(path){
  const root=(store&&store.root)||'';
  let p=String(path||'').replace(/\\/g,'/');
  const r=String(root).replace(/\\/g,'/').replace(/\/+$/,'');
  if(r&&p.toLowerCase().startsWith(r.toLowerCase()+'/'))p=p.slice(r.length+1);
  else if(r&&p.toLowerCase()===r.toLowerCase())p='';
  return p;
}
/* L'index de recherche se construit en lisant les .md, par lots de 32 (§6.6). */
async function buildIndexFromTree(){
  const files=[];
  const walk=ns=>ns.forEach(n=>{if(n.is_dir)walk(n.children||[]);else files.push(n)});
  walk(self_tree);
  syncDocsFromTree();
  for(let i=0;i<files.length;i+=32){
    const batch=files.slice(i,i+32);
    const texts=await Promise.all(batch.map(n=>store.read(toRel(n.path)).then(r=>r.content).catch(()=>'')));
    batch.forEach((n,j)=>search.update({id:toRel(n.path),title:nameOf(n),
                                       content:texts[j]||'',updatedAt:n.modified||0}));
  }
  list();
}
function buildNoRoot(){
  const L=$('#list');if(L)L.innerHTML='';
  const d=document.createElement('div');d.style.padding='8px';
  d.innerHTML='<p class="empty">Choisissez le dossier qui contient vos notes.</p>';
  const b=document.createElement('button');b.className='act-b';b.textContent='Choisir le dossier de notes';
  b.onclick=pickRootUI;d.appendChild(b);
  $('#list').appendChild(d);
}
/* Scroll visible clavier mobile/Bluetooth — MutationObserver supprimé, keepCaret appliqué */
function keepCaret(el){if(!el)return;/* scroll simple, sans observer */}
poke();
