/* Writer Deck — fonctions PURES.
   Aucune dépendance au DOM : utilisables dans le navigateur (window.WD) et sous
   node --test (module.exports). Extraites de l'ancien <script> inline sans modification
   de leur corps (invariant I1). */
const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const uid=()=>crypto.randomUUID?crypto.randomUUID():'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return(c=='x'?r:r&3|8).toString(16)});
function html(raw){
  if(raw==='---')return{cls:'hr',ind:0,h:'<span class="m">---</span>'};
  let m,cls='',pre='',rest=raw,ind=0;
  if(m=raw.match(/^(#{1,3} |> )/)){pre='<span class="m">'+esc(m[1])+'</span>';rest=raw.slice(m[1].length);cls=m[1][0]=='>'?'q':'h'+(m[1].length-1)}
  else if(m=raw.match(/^( *)(- \[[ xX]\] |[-*] |\d+\. )/)){
    const k=m[2];ind=m[1].length;rest=raw.slice(m[0].length);cls='li';
    pre=ind?'<span class="m">'+m[1]+'</span>':'';
    if(/^\d/.test(k))pre+='<span class="n">'+k+'</span>';
    else if(k[2]=='['){const x=/[xX]/.test(k[3]);if(x)cls+=' done';pre+='<span class="m" data-c="1" data-g="'+(x?'☑':'☐')+'">'+k+'</span>'}
    else pre+='<span class="m" data-g="•">'+k+'</span>';
  }
  const body=esc(rest).replace(/\*\*([^*]+)\*\*|\*([^*]+)\*/g,(m,a,b)=>a!=null?'<span class="m">**</span><b>'+a+'</b><span class="m">**</span>':'<span class="m">*</span><i>'+b+'</i><span class="m">*</span>');
  return{cls,ind,h:(pre+body)||'<br>'};
}
const norm=s=>s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
function stats(t){const w=t.replace(/[#>*]/g,' ').trim().split(/\s+/).filter(Boolean).length;return{w,r:w?Math.ceil(w/200):0,bytes:byteLen(t)}}
/* Taille en octets UTF-8, calculée sans TextEncoder (absent de certains contextes) */
function byteLen(t){let n=0;for(const ch of String(t||'')){const c=ch.codePointAt(0);n+=c<128?1:c<2048?2:c<65536?3:4}return n}
const slug=s=>(s||'document').replace(/[^\w\-]+/g,'_').slice(0,60);
const RX=/\*\*([^*]+)\*\*|\*([^*]+)\*/g;
const plain=t=>t.split('\n').map(l=>l==='---'?'———':l.replace(/^(#{1,3} |> )/,'').replace(/^( *)- \[ \] /,'$1☐ ').replace(/^( *)- \[[xX]\] /,'$1☑ ').replace(/^( *)[-*] /,'$1• ').replace(RX,(m,a,b)=>a!=null?a:b)).join('\n');
const inl=s=>esc(s).replace(RX,(m,a,b)=>a!=null?'<strong>'+a+'</strong>':'<em>'+b+'</em>');
function toHtml(d){
  const out=[],st=[],top=()=>st[st.length-1],pop=()=>out.push('</li></'+st.pop().tag+'>');
  d.content.split('\n').forEach(l=>{
    const m=l.match(/^( *)(- \[[ xX]\] |[-*] |\d+\. )/);
    if(m){
      const i=m[1].length,k=m[2],tag=/^\d/.test(k)?'ol':'ul';
      while(st.length&&top().ind>i)pop();
      if(st.length&&top().ind==i&&top().tag==tag)out.push('</li><li>');
      else{if(st.length&&top().ind==i)pop();out.push('<'+tag+'><li>');st.push({ind:i,tag})}
      const cb=k[2]=='['?'<input type="checkbox" disabled'+(/[xX]/.test(k)?' checked':'')+'> ':'';
      out[out.length-1]+=cb+inl(l.slice(m[0].length));return;/* même entrée que <li> : pas de saut de ligne dedans */
    }
    while(st.length)pop();
    if(!l.trim())return;
    if(l.trim()==='---')return out.push('<hr>');
    const h=l.match(/^(#{1,3}) (.*)/);if(h)return out.push('<h'+h[1].length+'>'+inl(h[2])+'</h'+h[1].length+'>');
    const q=l.match(/^> ?(.*)/);if(q)return q[1].trim()?out.push('<blockquote>'+inl(q[1])+'</blockquote>'):void 0;
    out.push('<p>'+inl(l)+'</p>');
  });
  while(st.length)pop();
  return'<!DOCTYPE html>\n<html lang="fr"><head><meta charset="utf-8"><meta name="description" content="Writer Deck — application minimaliste d\'écriture concentrée sur mobile."><meta name="keywords" content="écriture, notes, minimaliste, mobile, writer deck"><meta name="author" content="Joseph Humbert"><meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate"><meta name="theme-color" content="#000000"><link rel="manifest" href="manifest.json"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+esc(d.title||'Sans titre')+'</title>\n<style>body{max-width:68ch;margin:0 auto;padding:32px 20px;font:17px/1.75 Georgia,serif;color:#222;background:#fff}h1,h2,h3{line-height:1.3}blockquote{margin:1em 0;padding-left:16px;border-left:3px solid #222;color:#666}li input{margin-right:6px}li:has(>input){list-style:none;margin-left:-1.2em}@media(prefers-color-scheme:dark){body{background:#191919;color:#e3e2e0}blockquote{border-color:#e3e2e0;color:#999}}</style></head>\n<body>\n'+out.join('\n')+'\n</body></html>';
}
/* ---------- Tri d'arborescence (spec §5.7) ---------- */
/* Comparaison naturelle : "note2" < "note10", insensible à la casse et aux accents.
   Les runs de chiffres sont comparés NUMÉRIQUEMENT (sinon "10" < "2"). */
function natCmp(a,b){
  const A=nl(a),B=nl(b);
  for(let i=0;i<Math.max(A.length,B.length);i++){
    const x=A[i],y=B[i];
    if(x===undefined)return -1;
    if(y===undefined)return 1;
    if(x===y)continue;
    const nx=/^\d/.test(x),ny=/^\d/.test(y);
    if(nx&&ny){const d=Number(x)-Number(y);if(d)return d<0?-1:1;continue}
    return x<y?-1:1;
  }
  return 0;
}
function nl(s){
  return norm(String(s==null?'':s)).toLowerCase().match(/\d+|\D+/g)||[];
}
const extOf=p=>{const m=/\.([^.\/]+)$/.exec(String(p||''));return m?m[1].toLowerCase():''};
/* Dossiers TOUJOURS avant les fichiers, quel que soit le sens de tri.
   Renvoie une COPIE : l'entrée n'est jamais modifiée. Récursif sur `children`. */
function sortNodes(nodes,opt){
  const o=opt||{},key=o.key||'modified',dir=o.dir||'desc',sign=dir==='asc'?1:-1;
  const rank=n=>n&&n.is_dir?0:1;
  const byKeys=(a,b)=>{
    if(key==='name')return natCmp(a.name,b.name);
    if(key==='ext'){const c=natCmp(extOf(a.name),extOf(b.name));return c||natCmp(a.name,b.name)}
    const av=key==='size'?(a.size||0):(key==='created'?(a.created||a.modified||0):(a.modified||0));
    const bv=key==='size'?(b.size||0):(key==='created'?(b.created||b.modified||0):(b.modified||0));
    return av===bv?natCmp(a.name,b.name):(av<bv?-1:1);
  };
  const walk=list=>{
    if(!Array.isArray(list))return list;
    return list.map(n=>(n&&Array.isArray(n.children)?Object.assign({},n,{children:walk(n.children)}):n))
      .sort((a,b)=>rank(a)-rank(b)||byKeys(a,b)*sign||natCmp(a.name,b.name));
  };
  return walk(Array.isArray(nodes)?nodes:[]);
}

/* ---------- Réconciliation des modifications externes (spec §5.9) ---------- */
/* diskMtime === knownMtime -> rien ; changé et !dirty -> rechargement ;
   changé et dirty -> conflit (aucune fusion, l'utilisateur choisit) */
function reconcile(s){
  const st=s||{};
  if(st.diskMtime===st.knownMtime)return 'none';
  return st.dirty?'conflict':'reload';
}

/* ---------- Panneau « À propos & téléchargements » (spec §5.9) ---------- */
function detectPlatform(ua){
  const s=String(ua||'');
  if(/Android/i.test(s))return 'android';
  if(/iPhone|iPad|iPod/i.test(s))return 'ios';
  if(/Mac OS X|Macintosh/i.test(s))return 'mac';
  if(/Windows/i.test(s))return 'windows';
  if(/Linux|X11/i.test(s))return 'linux';
  return 'unknown';
}
function aboutLinks(cfg){
  const repo=String((cfg&&cfg.repo)||'').replace(/\/+$/,'');
  return{
    repo:repo,
    releases:repo+'/releases',
    latest:repo+'/releases/latest',
    issues:repo+'/issues',
    placeholder:repo===''||!repo||/OWNER/.test(repo)
  };
}
function assetHint(platform){
  if(platform==='linux')return 'AppImage, .deb ou .rpm';
  if(platform==='windows')return 'installeur .msi ou .exe';
  if(platform==='mac')return '.dmg';
  if(platform==='android'||platform==='ios')return 'Installez la PWA depuis votre navigateur';
  return 'Voir la page des versions';
}

/* Export double : navigateur (classic script) + node --test */
var WD={esc:esc,uid:uid,html:html,norm:norm,stats:stats,byteLen:byteLen,slug:slug,RX:RX,plain:plain,inl:inl,toHtml:toHtml,
        natCmp:natCmp,extOf:extOf,sortNodes:sortNodes,reconcile:reconcile,
        detectPlatform:detectPlatform,aboutLinks:aboutLinks,assetHint:assetHint};
if(typeof module!=='undefined')module.exports=WD;else window.WD=WD;
