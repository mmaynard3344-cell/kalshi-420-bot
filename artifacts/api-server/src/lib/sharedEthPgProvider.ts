import {pool} from "@workspace/db";
import type {TransactionProvider} from "./sharedEthClaimStore.js";
/** Shared PostgreSQL transaction provider; must use the same DB as all ETH services. */
export const sharedEthPgProvider:TransactionProvider={
 async transaction<T>(run:(tx:import("./sharedEthClaimStore.js").QueryClient)=>Promise<T>):Promise<T>{
  const client=await pool.connect();
  try{
   await client.query("BEGIN");
   const result=await run({query:async <R extends Record<string,unknown> = Record<string,unknown>>(sql:string,params:readonly unknown[]=[])=>{
    const response=await client.query(sql,[...params]);
    return {rows:response.rows as R[]};
   }});
   await client.query("COMMIT");
   return result;
  }catch(error){
   await client.query("ROLLBACK");
   throw error;
  }finally{client.release();}
 }
};
