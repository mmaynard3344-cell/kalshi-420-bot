import {pool} from "@workspace/db";
import type {TransactionProvider} from "./sharedEthClaimStore.js";
/** Shared PostgreSQL transaction provider; must use the same DB as all ETH services. */
export const sharedEthPgProvider:TransactionProvider={
 async transaction<T>(run:(tx:{query:(sql:string,params?:readonly unknown[])=>Promise<{rows:Record<string,unknown>[]}>})=>Promise<T>):Promise<T>{
  const client=await pool.connect();
  try{
   await client.query("BEGIN");
   const result=await run({query:async(sql,params=[])=>client.query(sql,[...params])});
   await client.query("COMMIT");
   return result;
  }catch(error){
   await client.query("ROLLBACK");
   throw error;
  }finally{client.release();}
 }
};
