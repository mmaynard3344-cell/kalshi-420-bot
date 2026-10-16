// Read-only audit: run inside the existing API service with its Kalshi credentials.
// This module performs GET requests only and never prints credentials.
import {kalshiAuthFetch} from "../src/lib/kalshiAuth.js";
const ticker = "KXETH15M-26OCT160700-00";
const from = Date.parse("2026-10-16T10:45:00Z");
const to = Date.parse("2026-10-16T11:00:00Z");
function ts(x:unknown){const n=typeof x==="number"?x:Number(x);return Number.isFinite(n)?n*1000:Date.parse(String(x??""))}
function relevant(o:Record<string,unknown>){const t=ts(o.created_time??o.created_at??o.created_ts);return o.ticker===ticker && (!Number.isFinite(t)||(t>=from&&t<=to))}
async function page(endpoint:string,key:string){
 const out:Record<string,unknown>[]=[];
 let cursor="";
 for(let i=0;i<10;i++){
  const q=new URLSearchParams({ticker,limit:"100"});
  if(cursor)q.set("cursor",cursor);
  const r=await kalshiAuthFetch<Record<string,unknown>>("GET",endpoint+"?"+q.toString());
  const items=r[key];if(!Array.isArray(items))throw Error("Missing "+key+" response");
  out.push(...items.filter((x):x is Record<string,unknown>=>!!x && typeof x==="object"));
  const next=r.cursor;
  if(typeof next!=="string"||!next||next===cursor)break;
  cursor=next;
 }
 return out.filter(relevant);
}
const [orders,fills]=await Promise.all([page("/portfolio/orders","orders"),page("/portfolio/fills","fills")]);
const summary={ticker,windowET:"2026-10-16 06:45-07:00",orders:orders.map(o=>({id:o.order_id,client:o.client_order_id,created:o.created_time??o.created_at,side:o.side,action:o.action,price:o.price,fillCount:o.fill_count_fp??o.fill_count,initialCount:o.initial_count_fp??o.initial_count,status:o.status})),fills:fills.map(f=>({orderId:f.order_id,created:f.created_time??f.ts,side:f.side,action:f.action,count:f.count_fp??f.count,yesPrice:f.yes_price,noPrice:f.no_price}))};
console.log(JSON.stringify(summary,null,2));
