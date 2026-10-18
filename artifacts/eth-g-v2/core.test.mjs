import test from "node:test";
import assert from "node:assert/strict";
import {decide,stake,nextStep,validateMarket} from "./core.mjs";
test("follows last of exactly two consecutive outcomes",()=>{
 assert.deepEqual(decide(["no","yes","yes"]),{fires:true,side:"yes",reason:"follow_last_settled_outcome"});
 assert.deepEqual(decide(["yes","no","no"]),{fires:true,side:"no",reason:"follow_last_settled_outcome"});
 for(const o of [["yes","yes","yes"],["no","no","no"],["yes","no","yes"],["yes",null,"yes"]]) assert.equal(decide(o).fires,false);
});
test("six steps reset on win and retain on verified zero-fill",()=>{
 let step=0;
 for(const amount of [200,400,800,1600,3200,6400]){assert.equal(stake(step),amount);step=nextStep(step,"loss")}
 assert.equal(step,0);assert.equal(nextStep(4,"win"),0);assert.equal(nextStep(3,"zero_fill"),3);
 assert.throws(()=>nextStep(1,"pending"),/unverified/);
});
test("refuses wrong ticker and expired markets",()=>{
 const m={ticker:"KXETH15M-26OCT181530-30",status:"active",floor_strike:3000,close_time:"2026-10-18T19:30:00Z"};
 assert.equal(validateMarket(m,Date.parse("2026-10-18T19:20:00Z"))?.ticker,m.ticker);
 assert.equal(validateMarket({...m,ticker:"KXBTC15M-X"},Date.parse("2026-10-18T19:20:00Z")),null);
 assert.equal(validateMarket(m,Date.parse("2026-10-18T19:30:00Z")),null);
});
