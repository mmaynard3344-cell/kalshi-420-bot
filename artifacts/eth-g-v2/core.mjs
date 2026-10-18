// Pure ETH G v2 core. No network, credentials, or live order operations.
export const STAKES_CENTS=Object.freeze([200,400,800,1600,3200,6400]);
export function decide(outcomes){
 if(!Array.isArray(outcomes)||outcomes.length!==3||!outcomes.every(v=>v==="yes"||v==="no"))
  return {fires:false,side:null,reason:"settlements_incomplete"};
 const [oldest,middle,latest]=outcomes;
 if(middle!==latest||oldest===middle)
  return {fires:false,side:null,reason:"exact_two_streak_not_met"};
 return {fires:true,side:latest,reason:"follow_last_settled_outcome"};
}
export function nextStep(current,outcome){
 if(!Number.isInteger(current)||current<0||current>5)throw Error("invalid_ladder_step");
 if(outcome==="win")return 0;
 if(outcome==="loss")return (current+1)%6;
 if(outcome==="zero_fill")return current;
 throw Error("unverified_outcome");
}
export function stake(step){
 if(!Number.isInteger(step)||step<0||step>5)throw Error("invalid_ladder_step");
 return STAKES_CENTS[step];
}
export function validateMarket(m,now){
 const end=Date.parse(m?.close_time),start=end-900000;
 if(!/^KXETH15M-[A-Z0-9-]+$/.test(m?.ticker||"")||!["active","open"].includes(m?.status)||
 !Number.isSafeInteger(now)||!Number.isSafeInteger(end)||end%900000!==0||now<start||now>=end||
 !Number.isFinite(Number(m?.floor_strike))||Number(m?.floor_strike)<=0) return null;
 return {ticker:m.ticker,windowStartMs:start,closeMs:end};
}
