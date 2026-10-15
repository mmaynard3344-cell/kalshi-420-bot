import { test, expect } from "bun:test";
import { initialLadder, wagerDollars, reserveOrder, markFilled, releaseNoFill, settle } from "../src/lib/marketSharedLadder";

test("losses advance 1,2,4,8,16,32 and sixth loss resets",()=>{
 let s=initialLadder("BTC");
 for(const expected of [1,2,4,8,16,32]){
   expect(wagerDollars(s)).toBe(expected);
   const id="order-"+expected;
   s=reserveOrder(s,id);
   s=markFilled(s,id,"settlement-"+expected);
   s=settle(s,"settlement-"+expected,"LOSS");
 }
 expect(wagerDollars(s)).toBe(1);
});
test("wins reset ladder and replayed settlements are idempotent",()=>{
 let s=initialLadder("EURUSD");
 s=markFilled(reserveOrder(s,"o1"),"o1","s1");
 s=settle(s,"s1","LOSS");
 expect(wagerDollars(s)).toBe(2);
 s=markFilled(reserveOrder(s,"o2"),"o2","s2");
 s=settle(s,"s2","WIN");
 expect(wagerDollars(s)).toBe(1);
 expect(settle(s,"s2","WIN")).toEqual(s);
});
test("pending orders block shared market ladder",()=>{
 let s=reserveOrder(initialLadder("ETH"),"a");
 expect(()=>reserveOrder(s,"b")).toThrow();
 s=markFilled(s,"a","settled-a");
 expect(()=>reserveOrder(s,"b")).toThrow();
 expect(()=>releaseNoFill(s,"a")).toThrow();
});
test("provable zero fill releases slot without advancing",()=>{
 let s=reserveOrder(initialLadder("ETH"),"order");
 s=releaseNoFill(s,"order");
 expect(wagerDollars(s)).toBe(1);
 expect(s.pendingOrderId).toBeNull();
});
test("unmatched settlement cannot change ladder",()=>{
 const s=initialLadder("BTC");
 expect(()=>settle(s,"unmatched","WIN")).toThrow();
});
