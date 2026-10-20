import assert from "node:assert/strict";
import test from "node:test";
import { reserveExit, fenceExitPost, linkExitProviderOrder, recordExitFill, type ExitDb, identifyTarget75ExchangeOrder } from "./target75ExitStore.js";

type Row = Record<string, unknown>;
class FakeExitDb implements ExitDb {
  exit: Row | null = null;
  fills = new Map<string, Row>();
  async transaction<T>(fn: (tx: ExitDb) => Promise<T>): Promise<T> { return fn(this); }
  async execute(q: unknown): Promise<{rows: Row[]}> {
    const query = q as { queryChunks?: unknown[] };
    // Drizzle SQL template interpolations are represented as queryChunks.
    const chunks = query.queryChunks ?? [];
    const literal = chunks.filter((v): v is {value:string[]} => typeof v === "object" && v !== null && "value" in v && Array.isArray((v as {value:unknown}).value))
      .map(x => x.value.join("")).join("");
    // Drizzle interpolated primitives are Param objects. Read their .value;
    // treating Param itself as a primitive gives a false test failure.
    const values = chunks.filter(v => !(typeof v === "object" && v !== null && "value" in v && Array.isArray((v as {value:unknown}).value)))
      .map(v => typeof v === "object" && v !== null && "value" in v ? (v as {value:unknown}).value : v);
    if (literal.includes("INSERT INTO eth_target75_exits")) {
      if (this.exit) return {rows:[]};
      const [key,strategy,ticker,entryId,side,quantity,bid] = values;
      this.exit = {exit_client_order_id:key,strategy,ticker,entry_order_id:entryId,
        held_side:side,requested_contracts:quantity,minimum_held_bid_cents:bid,status:"reserved",provider_order_id:null};
      return {rows:[{exit_client_order_id:key}]};
    }
    if (literal.includes("UPDATE eth_target75_exits") && literal.includes("SET status='post_started'")) {
      if (!this.exit || this.exit.status !== "reserved") return {rows:[]};
      this.exit.status="post_started";return {rows:[{exit_client_order_id:this.exit.exit_client_order_id}]};
    }
    if (literal.includes("UPDATE eth_target75_exits") && literal.includes("status='submitted'")) {
      if (!this.exit || this.exit.status !== "post_started") return {rows:[]};
      this.exit.status="submitted";this.exit.provider_order_id=values[0];
      return {rows:[{exit_client_order_id:this.exit.exit_client_order_id}]};
    }
    if (literal.includes("SELECT * FROM eth_target75_exits")) return {rows:this.exit?[{...this.exit}]:[]};
    if (literal.includes("SELECT COALESCE(SUM(contracts)")) return {rows:[{filled:[...this.fills.values()].reduce((n,x)=>n+Number(x.contracts),0)}]};
    if (literal.includes("INSERT INTO eth_target75_exit_fills")) {
      const [fillId,clientId,orderId,contracts,proceeds,fee] = values;
      if (this.fills.has(String(fillId))) return {rows:[]};
      this.fills.set(String(fillId),{provider_fill_id:fillId,exit_client_order_id:clientId,provider_order_id:orderId,contracts,gross_proceeds_cents:proceeds,fee_cents:fee});
      return {rows:[{provider_fill_id:fillId}]};
    }
    if (literal.includes("UPDATE eth_target75_exits") && literal.includes("RETURNING exit_client_order_id")) {
      if (!this.exit) return {rows:[]};
      this.exit.status=values[0];return {rows:[{exit_client_order_id:this.exit.exit_client_order_id}]};
    }
    throw Error("Unhandled fake SQL: "+literal.slice(0,160));
  }
}

test("ETH exit reserve -> fence -> provider ID -> unique partial fills", async () => {
  const db = new FakeExitDb();
  const request = {key:"exit-a",strategy:"G",ticker:"KXETH15M-TEST",entryId:"entry-a",side:"yes" as const,quantity:2,bidCents:75};
  assert.equal(await reserveExit(db,request),true);
  assert.equal(await reserveExit(db,request),false);
  assert.equal(await fenceExitPost(db,request.key),true);
  assert.equal(await fenceExitPost(db,request.key),false);
  assert.equal(await linkExitProviderOrder(db,request.key,"provider-a"),true);
  const fill = {strategy:"G",ticker:request.ticker,entryOrderId:"entry-a",exitClientOrderId:"exit-a",
    providerOrderId:"provider-a",providerFillId:"fill-a",heldSide:"yes" as const,
    contracts:1,grossProceedsCents:75,feeCents:1};
  assert.equal(await recordExitFill(db,fill),true);
  assert.equal(db.exit?.status,"partial");
  assert.equal(await recordExitFill(db,fill),false);
  assert.equal(await recordExitFill(db,{...fill,providerFillId:"fill-b"}),true);
  assert.equal(db.exit?.status,"filled");
  assert.equal(db.fills.size,2);
});
test("BTC excluded from ETH exit reservations", async () => {
  assert.equal(await reserveExit(new FakeExitDb(),{
    key:"btc",strategy:"G",ticker:"KXBTC15M-TEST",entryId:"btc",side:"yes",quantity:1,bidCents:75,
  }),false);
});

test("uncertain exit identifies only one exact provider order", () => {
  const input = {clientOrderId:"exit-a",ticker:"KXETH15M-TEST"};
  const correct = {client_order_id:"exit-a",ticker:"KXETH15M-TEST",order_id:"order-a"};
  assert.equal(identifyTarget75ExchangeOrder({...input,orderCandidates:[correct]}),"order-a");
  assert.equal(identifyTarget75ExchangeOrder({...input,orderCandidates:[correct,correct]}),null);
  assert.equal(identifyTarget75ExchangeOrder({...input,orderCandidates:[
    {...correct,ticker:"KXBTC15M-TEST"}]}),null);
  assert.equal(identifyTarget75ExchangeOrder({...input,orderCandidates:[]}),null);
});
