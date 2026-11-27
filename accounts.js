'use strict';
const crypto=require('crypto'),path=require('path'),{promisify}=require('util');
const scrypt=promisify(crypto.scrypt);
const options={N:32768,r:8,p:1,maxmem:64*1024*1024};
const digest=t=>crypto.createHash('sha256').update(t).digest('hex');
const validPassword=p=>typeof p==='string'&&p.length>=12&&p.length<=128&&Buffer.byteLength(p)<=512;
const validEmail=e=>typeof e==='string'&&e.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const clean=(v,max)=>typeof v==='string'&&v.trim().length>=2&&v.trim().length<=max?v.trim():null;
const hashPassword=async p=>{const salt=crypto.randomBytes(16);const h=await scrypt(p,salt,64,options);return 'scrypt1:'+salt.toString('hex')+':'+h.toString('hex')};
async function verifyPassword(p,encoded){const m=/^scrypt1:([a-f0-9]{32}):([a-f0-9]{128})$/.exec(encoded||'');const salt=m?Buffer.from(m[1],'hex'):Buffer.alloc(16);const expected=m?Buffer.from(m[2],'hex'):Buffer.alloc(64);const actual=await scrypt(p,salt,64,options);return !!m&&crypto.timingSafeEqual(actual,expected)}
module.exports=function registerAccounts(app,pool){
const COOKIE='dt_customer',TTL=12*60*60*1000;
const cookieOptions={httpOnly:true,secure:true,sameSite:'strict',path:'/conta'};
const attempts=new Map();let busy=0;
function limited(q,r,next){const now=Date.now();for(const [key,value] of attempts)if(value.until<=now)attempts.delete(key);const key=q.ip||'unknown';const a=attempts.get(key)||{count:0,until:now+900000};if(a.count>=8||busy>=4||(!attempts.has(key)&&attempts.size>=5000))return r.status(429).json({error:'limit'});a.count++;attempts.set(key,a);busy++;let released=false;const release=()=>{if(!released){released=true;busy--}};r.once('finish',release);r.once('close',release);next()}
function sessionToken(q){const v=(q.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);return /^[a-f0-9]{64}$/.test(v||'')?digest(v):null}
async function issue(q,r,id){const token=crypto.randomBytes(32).toString('hex');const key=digest(token);const prior=sessionToken(q);await pool.query('DELETE FROM customer_sessions WHERE expires_at<=now() OR token_hash=$1',[prior]);await pool.query('INSERT INTO customer_sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval \'12 hours\')',[key,id]);r.cookie(COOKIE,token,{...cookieOptions,maxAge:TTL})}
const wrap=fn=>async(q,r)=>{try{if(!pool)return r.status(503).json({error:'database'});await fn(q,r)}catch(e){console.warn('Account operation failed',e.code||e.name);if(!r.headersSent)r.status(503).json({error:'database'})}};
const profile='id,email,display_name,account_type,company_name,status,created_at';
async function findAccount(q){const key=sessionToken(q);if(!key)return null;const x=await pool.query('SELECT '+profile.split(',').map(x=>'a.'+x).join(',')+' FROM customer_sessions s JOIN customer_accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>now() AND a.status<>\'suspended\'',[key]);return x.rows[0]||null}
app.get('/conta',(q,r)=>{r.set('Cache-Control','no-store');r.sendFile(path.join(__dirname,'account.html'))});
app.use('/conta/api',(q,r,n)=>{r.set('Cache-Control','no-store');if(!['GET','HEAD'].includes(q.method)&&(!q.is('application/json')||q.headers['sec-fetch-site']==='cross-site'||q.headers.origin!=='https://'+q.get('host')))return r.status(403).json({error:'origin'});n()});
app.post('/conta/api/register',limited,wrap(async(q,r)=>{
const b=q.body||{},email=typeof b.email==='string'?b.email.trim().toLowerCase():'',name=clean(b.name,120),type=b.type,company=type==='business'?clean(b.company,150):null;
if(!validEmail(email)||!validPassword(b.password)||!name||!['personal','business'].includes(type)||(type==='business'&&!company))return r.status(400).json({error:'invalid'});
const pw=await hashPassword(b.password);
const x=await pool.query('INSERT INTO customer_accounts(email,display_name,account_type,company_name,password_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(email) DO NOTHING RETURNING '+profile,[email,name,type,company,pw]);
if(!x.rowCount)return r.status(409).json({error:'register_unavailable'});
await issue(q,r,x.rows[0].id);r.status(201).json({account:x.rows[0]});
}));
app.post('/conta/api/login',limited,wrap(async(q,r)=>{
const b=q.body||{},email=typeof b.email==='string'?b.email.trim().toLowerCase():'';
if(!validEmail(email)||!validPassword(b.password))return r.status(401).json({error:'auth'});
const x=await pool.query('SELECT '+profile+',password_hash FROM customer_accounts WHERE email=$1',[email]);const a=x.rows[0];const ok=await verifyPassword(b.password,a?.password_hash);if(!a||!ok||a.status==='suspended')return r.status(401).json({error:'auth'});
const {password_hash,...publicAccount}=a;await issue(q,r,a.id);r.json({account:publicAccount});
}));
app.get('/conta/api/me',wrap(async(q,r)=>{const a=await findAccount(q);if(!a)return r.status(401).json({error:'auth'});r.json({account:a})}));
app.post('/conta/api/logout',wrap(async(q,r)=>{const key=sessionToken(q);if(key)await pool.query('DELETE FROM customer_sessions WHERE token_hash=$1',[key]);r.clearCookie(COOKIE,cookieOptions).json({ok:true})}));
app.post('/conta/api/password',limited,wrap(async(q,r)=>{
const a=await findAccount(q);if(!a)return r.status(401).json({error:'auth'});const b=q.body||{};if(!validPassword(b.current)||!validPassword(b.next))return r.status(400).json({error:'invalid'});
const x=await pool.query('SELECT password_hash FROM customer_accounts WHERE id=$1',[a.id]);const old=x.rows[0]?.password_hash;if(!await verifyPassword(b.current,old))return r.status(401).json({error:'auth'});
const pw=await hashPassword(b.next);const result=await pool.query('WITH changed AS (UPDATE customer_accounts SET password_hash=$1 WHERE id=$2 AND password_hash=$3 AND status<>\'suspended\' RETURNING id), revoked AS (DELETE FROM customer_sessions WHERE account_id IN (SELECT id FROM changed)) SELECT id FROM changed',[pw,a.id,old]);if(!result.rowCount)return r.status(409).json({error:'retry'});
r.clearCookie(COOKIE,cookieOptions).json({ok:true});
}));
// These routes are installed AFTER the existing /admin/api authentication middleware.
app.get('/admin/api/accounts',wrap(async(q,r)=>{const page=Math.min(100000,Math.max(0,Number.isSafeInteger(Number(q.query.page))?Number(q.query.page):0));const x=await pool.query('SELECT '+profile+' FROM customer_accounts ORDER BY id DESC LIMIT 51 OFFSET $1',[page*50]);r.json({accounts:x.rows.slice(0,50),hasMore:x.rows.length>50,page})}));
app.patch('/admin/api/accounts/:id',wrap(async(q,r)=>{
const status=q.body?.status,id=q.params.id;if(!/^[1-9]\d{0,17}$/.test(id)||!['pending','active','suspended'].includes(status))return r.status(400).json({error:'invalid'});
const x=await pool.query('WITH changed AS (UPDATE customer_accounts SET status=$1 WHERE id=$2 RETURNING '+profile+'), revoked AS (DELETE FROM customer_sessions WHERE account_id IN (SELECT id FROM changed WHERE status=\'suspended\')) SELECT * FROM changed',[status,id]);if(!x.rowCount)return r.status(404).json({error:'not_found'});r.json({account:x.rows[0]});
}));
};