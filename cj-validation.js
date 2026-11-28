// CJ validation only. No catalogue writes, orders, payments or publishing.
module.exports=function(app){
 const base='https://developers.cjdropshipping.com/api2.0/v1';
 let cached=null, queue=Promise.resolve(), last=0;
 function request(endpoint, options={}) {
  const run=async()=>{await new Promise(r=>setTimeout(r,Math.max(0,1100-(Date.now()-last))));last=Date.now();
   const resp=await fetch(base+endpoint,{...options,redirect:'error',signal:AbortSignal.timeout(15000)});
   const j=await resp.json();if(!resp.ok||!j.result||![0,200].includes(j.code))throw Error('CJ_REQUEST_FAILED');return j.data;};
  const job=queue.then(run);queue=job.catch(()=>{});return job;
 }
 let pending;
 async function token(){if(cached&&Date.parse(cached.accessTokenExpiryDate)>Date.now()+60000)return cached.accessToken;
 if(!pending)pending=(async()=>{const apiKey=(process.env.CJ_API_KEY||'').trim();if(!apiKey)throw Error('CJ_API_KEY_MISSING');
 cached=await request('/authentication/getAccessToken',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey})});if(!cached?.accessToken)throw Error('CJ_AUTH_FAILED');return cached.accessToken;})().finally(()=>{pending=null});return pending;}
 async function read(endpoint,params){return request(endpoint+'?'+new URLSearchParams(params),{headers:{'CJ-Access-Token':await token()}})}
 const wrap=fn=>async(q,r)=>{try{r.json(await fn(q))}catch(e){r.status(503).json({error:e.message==='CJ_API_KEY_MISSING'?'CJ_API_KEY_MISSING':'CJ_UNAVAILABLE',salesEnabled:false})}};
 app.get('/admin/api/cj/status',wrap(async()=>({configured:!!process.env.CJ_API_KEY,mode:'validation',salesEnabled:false,authenticated:process.env.CJ_API_KEY?!!(await token()):false})));
 const id=(v)=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(v);
 app.get('/admin/api/cj/product/:pid',wrap(async q=>{if(!id(q.params.pid))return {error:'invalid_id'};return {salesEnabled:false,product:await read('/product/query',{pid:q.params.pid}),variants:await read('/product/variant/query',{pid:q.params.pid})}}));
 app.get('/admin/api/cj/stock/:vid',wrap(async q=>{if(!id(q.params.vid))return {error:'invalid_id'};return {salesEnabled:false,stock:await read('/product/stock/queryByVid',{vid:q.params.vid})}}));
};