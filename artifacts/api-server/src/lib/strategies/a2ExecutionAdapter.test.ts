import assert from "node:assert/strict";
import test from "node:test";
import {
  A2DryRunExecutionAdapter,
  A2ReadOnlyDryRunClient,
  deterministicA2ClientOrderId,
  sizeA2Order,
  type A2AcquireResult,
  type A2DryRunPayload,
  type A2ExecutionIntent,
  type A2ExecutionStore,
} from "./a2ExecutionAdapter.js";

class MemoryExecutionStore implements A2ExecutionStore {
  intents = new Map<string,A2ExecutionIntent>();
  byClient = new Map<string,string>();

  async acquireExposure(input:{id:string;signalId:string;marketTicker:string;clientOrderId:string;nowMs:number}):Promise<A2AcquireResult>{
    const priorId=this.byClient.get(input.clientOrderId);
    if(priorId) return {outcome:"duplicate",intent:this.intents.get(priorId)!};
    const active=[...this.intents.values()].find(x=>[
      "EXPOSURE_LOCKED","PRICE_CONFIRMED","ORDER_INTENT_CREATED","DRY_RUN_READY",
      "SUBMISSION_UNKNOWN","OPEN","PARTIALLY_FILLED","FILLED"
    ].includes(x.state));
    if(active) return {outcome:"active_exposure_limit",intent:null};
    const intent:A2ExecutionIntent={
      id:input.id,signalId:input.signalId,marketTicker:input.marketTicker,side:"yes",action:"buy",
      stakeCents:500,maxEntryPriceCents:45,clientOrderId:input.clientOrderId,state:"EXPOSURE_LOCKED",
      executableYesPriceCents:null,quantity:null,maxNotionalCents:null,priceCheckedAtMs:null,kalshiOrderId:null,
    };
    this.intents.set(intent.id,intent); this.byClient.set(intent.clientOrderId,intent.id);
    return {outcome:"acquired",intent};
  }
  async markDryRunReady(input:{id:string;executableYesPriceCents:number;quantity:number;maxNotionalCents:number;priceCheckedAtMs:number;payload:A2DryRunPayload}):Promise<boolean>{
    const row=this.intents.get(input.id); if(!row||row.state!=="EXPOSURE_LOCKED") return false;
    this.intents.set(input.id,{...row,state:"DRY_RUN_READY",executableYesPriceCents:input.executableYesPriceCents,quantity:input.quantity,maxNotionalCents:input.maxNotionalCents,priceCheckedAtMs:input.priceCheckedAtMs});
    return true;
  }
  async releaseUnsubmitted(input:{id:string;terminalState:"PRICE_TOO_HIGH"|"EXPIRED_UNSUBMITTED"|"REJECTED";reason:string;nowMs:number}):Promise<boolean>{
    const row=this.intents.get(input.id); if(!row) return false;
    this.intents.set(input.id,{...row,state:"EXPOSURE_RELEASED"}); return true;
  }
  async markSubmissionUnknown(input:{id:string;nowMs:number}):Promise<boolean>{
    const row=this.intents.get(input.id); if(!row) return false;
    this.intents.set(input.id,{...row,state:"SUBMISSION_UNKNOWN"}); return true;
  }
  async adoptExchangeOrder(input:{id:string;orderId:string;state:"OPEN"|"PARTIALLY_FILLED"|"FILLED";nowMs:number}):Promise<boolean>{
    const row=this.intents.get(input.id); if(!row) return false;
    this.intents.set(input.id,{...row,state:input.state,kalshiOrderId:input.orderId}); return true;
  }
  async settleAndRelease(input:{id:string;result:"yes"|"no";realizedPnlCents:number;nowMs:number}):Promise<boolean>{
    const row=this.intents.get(input.id); if(!row) return false;
    this.intents.set(input.id,{...row,state:"EXPOSURE_RELEASED"}); return true;
  }
  async getIntentByClientOrderId(clientOrderId:string):Promise<A2ExecutionIntent|null>{
    const id=this.byClient.get(clientOrderId); return id?this.intents.get(id)??null:null;
  }
}

function client(price:number|null){
  return new A2ReadOnlyDryRunClient(
    async()=>price,
    async()=>null,
  );
}

test("45 cent re-check sizes at 11 contracts and $4.95",async()=>{
  assert.deepEqual(sizeA2Order(45),{quantity:11,maxNotionalCents:495});
  const store=new MemoryExecutionStore();
  const adapter=new A2DryRunExecutionAdapter(store,client(45));
  const r=await adapter.prepare({signalId:"sig-1",marketTicker:"KXBTC15M-TEST",nowMs:1000});
  assert.equal(r.would_submit,true);
  assert.equal(r.submission_performed,false);
  assert.equal(r.order_payload?.count,11);
  assert.equal(r.order_payload?.yes_price,45);
});

test("46 cent final re-check blocks and releases exposure",async()=>{
  const store=new MemoryExecutionStore();
  const adapter=new A2DryRunExecutionAdapter(store,client(46));
  const r=await adapter.prepare({signalId:"sig-2",marketTicker:"KXBTC15M-TEST2",nowMs:1000});
  assert.equal(r.would_submit,false);
  assert.deepEqual(r.blockers,["entry_price_above_cap"]);
  assert.equal([...store.intents.values()][0]?.state,"EXPOSURE_RELEASED");
});

test("duplicate signal yields same durable client order id",async()=>{
  const store=new MemoryExecutionStore();
  const adapter=new A2DryRunExecutionAdapter(store,client(40));
  const a=await adapter.prepare({signalId:"same-signal",marketTicker:"KXBTC15M-X",nowMs:1000});
  const b=await adapter.prepare({signalId:"same-signal",marketTicker:"KXBTC15M-X",nowMs:2000});
  assert.equal(a.order_payload?.client_order_id,b.order_payload?.client_order_id);
  assert.equal(store.intents.size,1);
});

test("deterministic id is stable and input-sensitive",()=>{
  const a=deterministicA2ClientOrderId({marketTicker:"KXBTC15M-A",signalId:"s"});
  const b=deterministicA2ClientOrderId({marketTicker:"KXBTC15M-A",signalId:"s"});
  const c=deterministicA2ClientOrderId({marketTicker:"KXBTC15M-B",signalId:"s"});
  assert.equal(a,b); assert.notEqual(a,c);
});

test("two workers produce exactly one active exposure",async()=>{
  const store=new MemoryExecutionStore();
  const a=new A2DryRunExecutionAdapter(store,client(40));
  const b=new A2DryRunExecutionAdapter(store,client(40));
  const [r1,r2]=await Promise.all([
    a.prepare({signalId:"s1",marketTicker:"KXBTC15M-1",nowMs:1000}),
    b.prepare({signalId:"s2",marketTicker:"KXBTC15M-2",nowMs:1000}),
  ]);
  assert.equal([r1.would_submit,r2.would_submit].filter(Boolean).length,1);
});

test("submission unknown holds slot and reconciliation adopts existing order",async()=>{
  const store=new MemoryExecutionStore();
  const seed=new A2DryRunExecutionAdapter(store,client(40));
  const ready=await seed.prepare({signalId:"sig-u",marketTicker:"KXBTC15M-U",nowMs:1000});
  const id=ready.intent_id!;
  assert.equal(await store.markSubmissionUnknown({id,nowMs:1100}),true);
  const coid=ready.order_payload!.client_order_id;
  const exchange=new A2ReadOnlyDryRunClient(
    async()=>40,async()=>null,
    async(clientOrderId)=>clientOrderId===coid?{orderId:"ord-1",clientOrderId,status:"partially_filled",filledCount:3}:null,
  );
  const adapter=new A2DryRunExecutionAdapter(store,exchange);
  assert.equal(await adapter.reconcileUnknown(coid,1200),"adopted");
  assert.equal((await store.getIntentByClientOrderId(coid))?.state,"PARTIALLY_FILLED");
});

test("repeated settlement is idempotent at adapter/store boundary",async()=>{
  const store=new MemoryExecutionStore();
  const firstClient=new A2ReadOnlyDryRunClient(async()=>25,async()=>"yes");
  const adapter=new A2DryRunExecutionAdapter(store,firstClient);
  const ready=await adapter.prepare({signalId:"sig-s",marketTicker:"KXBTC15M-S",nowMs:1000});
  const coid=ready.order_payload!.client_order_id;
  assert.equal(await adapter.settle(coid,2000),"settled");
  assert.equal(await adapter.settle(coid,3000),"settled");
  assert.equal((await store.getIntentByClientOrderId(coid))?.state,"EXPOSURE_RELEASED");
});
