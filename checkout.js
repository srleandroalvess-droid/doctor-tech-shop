'use strict';
const crypto=require('crypto'),path=require('path');
const fail=(status,code)=>Object.assign(Error(code),{httpStatus:status,publicCode:code});
const idOk=x=>typeof x==='string'&&/^[1-9]\d{0,17}$/.test(x);
const str=(x,min,max)=>typeof x==='string'&&x.trim().length>=min&&x.trim().length<=max?x.trim():null;
const integer=(x,min,max)=>Number.isSafeInteger(x)&&x>=min&&x<=max;
const states=new Set(['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO']);
function delivery(b){if(!b||typeof b!=='object')throw fail(400,'address');const d={recipient:str(b.recipient,2,120),cep:typeof b.cep==='string'?b.cep.replace(/\D/g,''):'',street:str(b.street,2,150),number:str(b.number,1,20),district:str(b.district,2,100),city:str(b.city,2,100),uf:String(b.uf||'').toUpperCase(),complement:b.complement?str(b.complement,1,120):''};if(!d.recipient||!/^\d{8}$/.test(d.cep)||!d.street||!d.number||!d.district||!d.city||!states.has(d.uf)||d.complement===null)throw fail(400,'address');return d}
function normalizeItems(items){if(!Array.isArray(items)||!items.length||items.length>20)throw fail(400,'cart');const ids=new Set();for(const x of items){if(!x||!idOk(x.id)||ids.has(x.id)||!integer(x.quantity,1,20)||!integer(x.price_cents,1,2147483647))throw fail(400,'cart');ids.add(x.id)}return items}
const profileCols='id,reference,status,subtotal_cents,shipping_cents,total_cents,tracking,created_at,updated_at';
function paymentLink(v){if(typeof v!=='string'||v.length>1500)throw fail(400,'payment_url');try{const u=new URL(v.trim());if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||!((u.hostname==='mpago.la'&&/^\/[A-Za-z0-9_-]{4,100}$/.test(u.pathname)&&!u.search)||(u.hostname==='www.mercadopago.com.br'&&u.pathname==='/checkout/v1/redirect'&&/^[A-Za-z0-9_-]{5,250}$/.test(u.searchParams.get('pref_id')||'')&&[...u.searchParams.keys()].every(k=>k==='pref_id'))))throw Error();return u.href}catch{throw fail(400,'payment_url')}}
const customerFields=profileCols.split(',').map(k=>'o.'+k).join(',')+",CASE WHEN o.status='confirmed' THEN o.payment_url ELSE NULL END AS payment_url";
const itemCols='product_id,product_name,quantity,unit_price_cents';
function token(q){const v=(q.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('dt_customer='))?.slice(12);return /^[a-f0-9]{64}$/.test(v||'')?crypto.createHash('sha256').update(v).digest('hex'):null}
async function account(db,q,lock=false){const t=token(q);if(!t)throw fail(401,'auth');const x=await db.query("SELECT a.id,a.status FROM customer_accounts a JOIN customer_sessions s ON s.account_id=a.id WHERE s.token_hash=$1 AND s.expires_at>now() AND a.status<>'suspended'"+(lock?' FOR UPDATE OF a,s':''),[t]);if(!x.rowCount)throw fail(401,'auth');return x.rows[0]}
async function tx(pool,fn){const c=await pool.connect();try{await c.query('BEGIN');const x=await fn(c);await c.query('COMMIT');return x}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}finally{c.release()}}
const commercial="p.active AND s.active AND p.costs_validated_at IS NOT NULL AND p.price_cents>0 AND p.cost_cents>0 AND p.freight_cents IS NOT NULL AND p.extra_cents IS NOT NULL AND p.fee_bps IS NOT NULL AND p.fee_bps+p.margin_bps<10000 AND p.price_cents::numeric*(10000-p.fee_bps-p.margin_bps)>=(p.cost_cents::numeric+p.freight_cents+p.extra_cents)*10000 AND p.image_authorized AND p.image_url LIKE 'https://%' AND (NULLIF(btrim(p.supplier_url),'') IS NOT NULL OR NULLIF(btrim(p.cj_vid),'') IS NOT NULL)";
const eligible=commercial+" AND p.stock_confirmed_quantity>0 AND p.stock_confirmed_at IS NOT NULL AND p.sale_approved_until>now() AND p.sale_approval_note IS NOT NULL";
const wrap=(pool,fn)=>async(q,r)=>{try{if(!pool)throw fail(503,'database');await fn(q,r)}catch(e){if(!e.httpStatus)console.warn('Checkout operation failed',e.code||e.name);if(!r.headersSent)r.status(e.httpStatus||503).json({error:e.publicCode||'database'})}};
async function listOrders(db,where,args,admin){const fields=admin?'o.*,a.display_name,a.email,a.account_type,a.company_name':customerFields;const x=await db.query('SELECT '+fields+' FROM checkout_orders o '+(admin?'JOIN customer_accounts a ON a.id=o.account_id ':'')+'WHERE '+where+' ORDER BY o.id DESC LIMIT 51',args);const orders=x.rows.slice(0,50);if(orders.length){const y=await db.query('SELECT order_id,'+itemCols+' FROM checkout_order_items WHERE order_id=ANY($1::bigint[]) ORDER BY order_id,product_id',[orders.map(o=>o.id)]);for(const o of orders)o.items=y.rows.filter(i=>String(i.order_id)===String(o.id))}return {orders,hasMore:x.rows.length>50}}
module.exports=function checkout(app,pool){
const run=fn=>wrap(pool,fn);
app.get('/conta/pedidos',(q,r)=>{r.set('Cache-Control','no-store');r.sendFile(path.join(__dirname,'checkout.html'))});
app.get('/admin/pedidos',(q,r)=>{r.set('Cache-Control','no-store');r.sendFile(path.join(__dirname,'orders-admin.html'))});
// /conta/api origin and cache middleware is registered by accounts.js first.
// /admin/api routes are behind the existing administrator auth middleware.
app.get('/conta/api/orders',run(async(q,r)=>{const a=await account(pool,q);const before=q.query.before;const args=[a.id];let where='o.account_id=$1';if(before){if(!idOk(before))throw fail(400,'input');args.push(before);where+=' AND o.id<$2'}r.json(await listOrders(pool,where,args,false))}));
app.post('/conta/api/orders',run(async(q,r)=>{
const b=q.body||{},items=normalizeItems(b.items),d=delivery(b.delivery),key=b.request_key;
if(typeof key!=='string'||!/^[a-f0-9-]{36}$/.test(key))throw fail(400,'cart');
const result=await tx(pool,async c=>{
const a=await account(c,q,true);if(a.status!=='active')throw fail(403,'pending');
const prior=await c.query('SELECT '+profileCols+' FROM checkout_orders WHERE account_id=$1 AND request_key=$2',[a.id,key]);if(prior.rowCount)return {order:prior.rows[0],duplicate:true};
const count=await c.query("SELECT count(*)::int n FROM checkout_orders WHERE account_id=$1 AND status IN ('requested','confirmed')",[a.id]);if(count.rows[0].n>=5)throw fail(409,'limit');
const x=await c.query('SELECT p.id,p.name,p.price_cents,p.cost_cents,p.freight_cents,p.extra_cents,p.fee_bps,p.stock_confirmed_quantity FROM products p JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=ANY($1::bigint[]) AND '+eligible+' ORDER BY p.id FOR UPDATE OF p,s',[items.map(i=>i.id)]);
if(x.rowCount!==items.length)throw fail(409,'unavailable');
let subtotal=0;for(const i of items){const p=x.rows.find(z=>String(z.id)===i.id);if(!p||p.stock_confirmed_quantity<i.quantity)throw fail(409,'unavailable');if(Number(p.price_cents)!==i.price_cents)throw fail(409,'price_changed');subtotal+=i.quantity*Number(p.price_cents)}if(!Number.isSafeInteger(subtotal)||subtotal<1)throw fail(400,'cart');
const ref='DT-'+crypto.randomBytes(9).toString('hex').toUpperCase();
const o=(await c.query('INSERT INTO checkout_orders(reference,account_id,request_key,delivery,subtotal_cents) VALUES($1,$2,$3,$4::jsonb,$5) RETURNING '+profileCols,[ref,a.id,key,JSON.stringify(d),subtotal])).rows[0];
for(const i of items){const p=x.rows.find(z=>String(z.id)===i.id);await c.query('INSERT INTO checkout_order_items(order_id,product_id,product_name,quantity,unit_price_cents,unit_cost_cents,unit_freight_cents,unit_extra_cents,fee_bps) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[o.id,p.id,p.name,i.quantity,p.price_cents,p.cost_cents,p.freight_cents,p.extra_cents,p.fee_bps]);await c.query('UPDATE products SET stock_confirmed_quantity=stock_confirmed_quantity-$1 WHERE id=$2',[i.quantity,p.id])}
return {order:o,duplicate:false};
});r.status(result.duplicate?200:201).json(result)
}));
app.get('/admin/api/checkout-products',run(async(q,r)=>{
const x=await pool.query("SELECT p.id,p.name,p.active,p.costs_validated_at,p.price_cents,p.cost_cents,p.freight_cents,p.extra_cents,p.fee_bps,p.margin_bps,p.image_authorized,p.image_url,p.image_permission_source,p.stock_confirmed_quantity,p.sale_approved_until,p.sale_approval_note,s.name supplier_name,COALESCE(s.active,false) supplier_active,EXISTS(SELECT 1 FROM checkout_eligible_products e WHERE e.id=p.id) eligible FROM products p LEFT JOIN suppliers s ON s.id=p.supplier_id ORDER BY p.id LIMIT 500");r.json({products:x.rows})
}));
app.post('/admin/api/checkout-products/:id/approval',run(async(q,r)=>{
const id=q.params.id,b=q.body||{};if(!idOk(id)||!integer(b.stock,1,100000)||!integer(b.hours,1,24)||!str(b.evidence,10,1000)||b.confirmed!==true)throw fail(400,'approval');
let photo=null,permission=null;if(b.photo||b.permission){try{const u=new URL(b.photo);if(u.protocol!=='https:'||u.username||u.password||u.href.length>1500)throw Error();photo=u.href;permission=str(b.permission,10,1000);if(!permission)throw Error()}catch{throw fail(400,'photo')}}
const result=await tx(pool,async c=>{
const p=(await c.query('SELECT p.id FROM products p JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=$1 AND p.active AND s.active AND p.costs_validated_at IS NOT NULL FOR UPDATE OF p,s',[id])).rows[0];if(!p)throw fail(409,'commercial');
if(photo)await c.query('UPDATE products SET image_url=$1,image_authorized=true,image_permission_source=$2,image_permission_checked_at=now() WHERE id=$3',[photo,permission,id]);
const z=await c.query('SELECT p.id FROM products p JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=$1 AND '+commercial,[id]);if(!z.rowCount)throw fail(409,'commercial');
const x=await c.query("UPDATE products SET stock_confirmed_quantity=$1,stock_confirmed_at=now(),sale_approved_until=now()+$2::int*interval '1 hour',sale_approval_note=$3 WHERE id=$4 RETURNING id,stock_confirmed_quantity,sale_approved_until",[b.stock,b.hours,b.evidence.trim(),id]);return x.rows[0];
});r.json({product:result});
}));
app.post('/admin/api/checkout-products/:id/pause',run(async(q,r)=>{if(!idOk(q.params.id))throw fail(400,'input');const x=await pool.query('UPDATE products SET sale_approved_until=NULL,stock_confirmed_quantity=NULL,stock_confirmed_at=NULL,sale_approval_note=NULL WHERE id=$1 RETURNING id',[q.params.id]);if(!x.rowCount)throw fail(404,'not_found');r.json({ok:true})}));
app.get('/admin/api/checkout-orders',run(async(q,r)=>{const before=q.query.before;let where='true',args=[];if(before){if(!idOk(before))throw fail(400,'input');where='o.id<$1';args=[before]}r.json(await listOrders(pool,where,args,true))}));
app.post('/admin/api/checkout-orders/:id/payment-link',run(async(q,r)=>{
const id=q.params.id;if(!idOk(id))throw fail(400,'input');const b=q.body||{};if(b.confirmed!==true)throw fail(400,'payment_url');const link=paymentLink(b.url);
const x=await pool.query("UPDATE checkout_orders SET payment_url=$1,updated_at=now() WHERE id=$2 AND status='confirmed' AND total_cents=$3 AND total_cents>0 RETURNING id,reference,payment_url",[link,id,integer(b.total_cents,1,Number.MAX_SAFE_INTEGER)?b.total_cents:0]);if(!x.rowCount)throw fail(409,'transition');r.json({order:x.rows[0]})
}));
app.get('/admin/api/checkout-finance',run(async(q,r)=>{
const x=await pool.query("SELECT count(*)::int AS orders,count(*) FILTER (WHERE status IN ('paid','shipped','delivered'))::int AS paid_orders,COALESCE(sum(total_cents) FILTER (WHERE status IN ('paid','shipped','delivered')),0) AS gross_cents,COALESCE(sum(payment_fee_cents) FILTER (WHERE status IN ('paid','shipped','delivered')),0) AS known_payment_fees_cents,count(*) FILTER (WHERE status IN ('paid','shipped','delivered') AND payment_fee_cents IS NULL)::int AS missing_fee_count FROM checkout_orders");r.json(x.rows[0])
}));
app.patch('/admin/api/checkout-orders/:id',run(async(q,r)=>{
const id=q.params.id,b=q.body||{};if(!idOk(id)||!['confirmed','paid','shipped','delivered','cancelled'].includes(b.status))throw fail(400,'input');
const result=await tx(pool,async c=>{
const x=await c.query('SELECT * FROM checkout_orders WHERE id=$1 FOR UPDATE',[id]);if(!x.rowCount)throw fail(404,'not_found');const o=x.rows[0];
const transitions={requested:['confirmed','cancelled'],confirmed:['paid','cancelled'],paid:['shipped'],shipped:['delivered'],delivered:[],cancelled:[]};if(!transitions[o.status]?.includes(b.status))throw fail(409,'transition');
let shipping=o.shipping_cents,total=o.total_cents,tracking=o.tracking,paymentRef=o.payment_reference,paymentFee=o.payment_fee_cents;
if(b.status==='confirmed'){if(!integer(b.shipping_cents,0,10000000)||b.confirmed!==true)throw fail(400,'shipping');shipping=b.shipping_cents;total=Number(o.subtotal_cents)+shipping;if(!Number.isSafeInteger(total))throw fail(400,'shipping')}
if(b.status==='paid'){paymentRef=str(b.payment_reference,3,120);paymentFee=b.payment_fee_cents===null?null:b.payment_fee_cents;if(b.confirmed!==true||!paymentRef||!integer(b.received_cents,1,Number.MAX_SAFE_INTEGER)||b.received_cents!==Number(o.total_cents)||(paymentFee!==null&&!integer(paymentFee,0,b.received_cents)))throw fail(400,'payment')}
if(b.status==='shipped'){tracking=str(b.tracking,2,120);if(!tracking)throw fail(400,'tracking')}
const y=await c.query("UPDATE checkout_orders SET status=$1,shipping_cents=$2,total_cents=$3,tracking=$4,payment_reference=$6,payment_fee_cents=$7,payment_confirmed_at=CASE WHEN $1='paid' THEN now() ELSE payment_confirmed_at END,payment_url=CASE WHEN $1 IN ('paid','cancelled') THEN NULL ELSE payment_url END,updated_at=now() WHERE id=$5 RETURNING "+profileCols,[b.status,shipping,total,tracking,id,paymentRef,paymentFee]);return y.rows[0];
});r.json({order:result})
}));
};