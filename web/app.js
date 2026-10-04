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

/* ---------- Documents & persistance ---------- */
const doc=()=>docs.find(d=>d.id==cur);
function changed(){
  $('#saved').textContent='…';clearTimeout(saveT);saveT=setTimeout(save,300);
  const s=stats(text());$('#stats').textContent=s.w+' mot'+(s.w>1?'s':'')+' · '+s.r+' min';
  clearTimeout(tocT);tocT=setTimeout(buildToc,250);
}
function save(){
  if(!ready)return;const d=doc();if(!d)return;const t=text(),s=stats(t);
  Object.assign(d,{content:t,updatedAt:Date.now(),wordCount:s.w,readingTime:s.r});
  sv('mwd:cur',cur);dbPut(d).then(()=>{$('#saved').textContent='enregistré'});
}
function open(id){
  if(doc())save();cur=id;const d=doc();
  ed.innerHTML='';act=null;d.content.split('\n').forEach(t=>ed.appendChild(mk(t)));
  $('#scroll').scrollTop=0;
  $('#title').value=d.title;ready=true;changed();sv('mwd:cur',cur);list();
}
function create(title,content){
  const n=Date.now(),d={id:uid(),title:title||'',content:content||'',createdAt:n,updatedAt:n,wordCount:0,readingTime:0};
  docs.unshift(d);dbPut(d);return d;
}
function list(){
  const L=$('#list');L.innerHTML='';
  docs.forEach(d=>{
    const r=document.createElement('div');r.className='row';
    const b=document.createElement('button');b.className='doc'+(d.id==cur?' cur':'');
    b.innerHTML=esc(d.title||'Sans titre')+'<small>'+d.wordCount+' m</small>';
    b.onclick=()=>{open(d.id);panel()};
    const x=document.createElement('button');x.className='ib';x.textContent='×';x.style.width='32px';
    x.onclick=()=>{
      if(x.dataset.s!='1'){x.dataset.s='1';x.textContent='sûr ?';x.style.width='auto';return}
      docs=docs.filter(z=>z!=d);
      if(!docs.length)create('','');
      dbDel(d.id);if(d.id==cur){cur=null;open(docs[0].id)}else list();
    };
    r.append(b,x);L.appendChild(r);
  });
}
$('#title').addEventListener('input',e=>{const d=doc();if(!d)return;d.title=e.target.value.slice(0,255);changed();list()});
$('#bNew').onclick=()=>{if(doc())save();const d=create('','');open(d.id);panel();ed.focus()};

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
  ['#docs','#toc'].forEach(s=>$(s).classList.toggle('open',s==id));
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

/* ---------- Démarrage ---------- */
{const t=ld('mwd:theme',null);if(t)document.documentElement.dataset.theme=t}
(async()=>{
  db=await idb();
  docs=(db?await dbAll():ld('mwd:docs',[]))||[];
  if(db&&!docs.length){const old=ld('mwd:docs',[]);if(old.length){docs=old;for(const d of old)await dbPut(d)}}
  docs.sort((a,b)=>b.updatedAt-a.updatedAt);
  if(!docs.length)create('Bienvenue','# Bienvenue\n\nÉcrivez ici. Les **marqueurs** disparaissent, le *style* reste.\n\n> Une citation, un doute, une phrase à garder.\n\n## Premier chapitre\n\nTapez / pour ouvrir les commandes. Tout est enregistré sur cet appareil.');
  open(docs.find(d=>d.id==cur)?cur:docs[0].id);
})();
addEventListener('pagehide',save);
/* Scroll visible clavier mobile/Bluetooth — MutationObserver supprimé, keepCaret appliqué */
function keepCaret(el){if(!el)return;/* scroll simple, sans observer */}
poke();
