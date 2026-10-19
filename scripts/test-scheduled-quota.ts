// Real PostgreSQL cost-aware scheduled quotas, concurrent edits and publication lock ordering.
import assert from "node:assert/strict";
import type { Viewer } from "../src/auth";
import { sql } from "../src/db";
import { newId } from "../src/ids";
import { PostError } from "../src/posts";
import { runDue, scheduledHandlers as h } from "../src/scheduled";
const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");
const id=newId(), v={id} as Viewer, at=Math.floor(Date.now()/1000)+3600;
const request=(n:number)=>({status:"quota root",thread_tweets:Array.from({length:n-1},(_,i)=>({status:`quota reply ${i}`}))});
const create=(n:number)=>h.CreateScheduledTweet(v,{execute_at:at,post_tweet_request:request(n)});
const edit=(rest:string,n:number)=>h.EditScheduledTweet(v,{scheduled_tweet_id:rest,execute_at:at,post_tweet_request:request(n)});
const clear=()=>sql`delete from scheduled_posts where user_id=${id}::bigint`;
const total=async()=>Number((await sql`select coalesce(sum(1+case when jsonb_typeof(request->'thread_tweets')='array' then jsonb_array_length(request->'thread_tweets') else 0 end),0)::int n from scheduled_posts where user_id=${id}::bigint and kind='scheduled'`)[0].n);
const quota=(error:unknown)=>error instanceof PostError && error.code===214;
let release:(()=>void)|undefined, holder:Promise<unknown>|undefined, worker:Promise<number>|undefined, editing:Promise<unknown>|undefined;
try {
 await sql`insert into users(id,screen_name,name,password_hash) values (${id}::bigint,${`quota_${id}`},'Quota fixture','!')`;
 const concurrent=await Promise.allSettled(Array.from({length:5},()=>create(26)));
 assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,3);
 assert(concurrent.filter(r=>r.status==='rejected').every((r:any)=>quota(r.reason)));
 assert.equal(await total(),78);
 const existing=(concurrent.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<any>).value.data.tweet.rest_id;
 await create(22);assert.equal(await total(),100);await assert.rejects(()=>create(1),quota);
 await edit(existing,26);assert.equal(await total(),100,"same-size editing remains allowed at full quota");
 await edit(existing,25);await create(1);assert.equal(await total(),100);
 console.log("ok: five concurrent26-post thread creations stop at78, remaining22 fit exactly, full-quota same/shrink edits work");
 await clear();
 const base=BigInt(newId());
 await sql`insert into scheduled_posts(id,user_id,kind,execute_at,request)
  select ${base.toString()}::bigint+n,${id}::bigint,'scheduled',${new Date(at*1000)},'{"status":"quota baseline","media_ids":[],"thread_tweets":[]}'::jsonb from generate_series(1,96)n`;
 const a=(await create(1)).data.tweet.rest_id,b=(await create(1)).data.tweet.rest_id;
 const expanded=await Promise.allSettled([edit(a,3),edit(b,3)]);
 assert.equal(expanded.filter(r=>r.status==='fulfilled').length,1);assert.equal(expanded.filter(r=>r.status==='rejected').length,1);assert.equal(await total(),100);
 const legacy=newId();await sql`insert into scheduled_posts(id,user_id,kind,execute_at,request) values (${legacy}::bigint,${id}::bigint,'scheduled',${new Date(at*1000)},${JSON.stringify(request(26))}::text::jsonb)`;
 assert.equal(await total(),126);await edit(legacy,26);await edit(legacy,25);assert.equal(await total(),125);
 await assert.rejects(()=>edit(legacy,26),quota);
 console.log("ok: concurrent thread expansions cannot overfill quota; legacy-overquota queues retain same/shrinking edits");
 await clear();
 const draftBase=BigInt(newId());
 await sql`insert into scheduled_posts(id,user_id,kind,request)
  select ${draftBase.toString()}::bigint+n,${id}::bigint,'draft',${JSON.stringify(request(26))}::text::jsonb from generate_series(1,100)n`;
 await h.EditDraftTweet(v,{draft_tweet_id:(draftBase+1n).toString(),post_tweet_request:request(26)});
 await assert.rejects(()=>h.CreateDraftTweet(v,{post_tweet_request:request(1)}),quota);
 assert.equal((await sql`select count(*)::int n from scheduled_posts where user_id=${id}::bigint and kind='draft'`)[0].n,100);
 console.log("ok: draft quota still counts100 logical drafts rather than2600 saved thread posts, with editing allowed");
 await clear();
 const due=(await create(2)).data.tweet.rest_id;
 await sql`update scheduled_posts set execute_at=now()-interval '1 second' where id=${due}::bigint`;
 const locked=Promise.withResolvers<void>(),resume=Promise.withResolvers<void>();release=()=>resume.resolve();
 holder=sql.begin(async(tx)=>{await tx`select id from users where id=${id}::bigint for update`;locked.resolve();await resume.promise;});
 await locked.promise;worker=runDue();
 async function waitQuery(pattern:string){const deadline=Date.now()+10000;while(!(await sql`select 1 from pg_stat_activity where datname=current_database() and wait_event='transactionid' and query like ${pattern}`).length){assert(Date.now()<deadline,`expected blocked query ${pattern}`);await Bun.sleep(10);}}
 await waitQuery('insert into posts%');
 editing=edit(due,2);const editResult=editing.then(()=>({ok:true}),error=>({error}));
 await waitQuery('select request from scheduled_posts%for update%');
 release();await holder;
 assert.equal(await worker,1);const outcome=await editResult;assert('error'in outcome && outcome.error instanceof PostError && outcome.error.code===144);
 assert.equal((await sql`select count(*)::int n from posts where user_id=${id}::bigint`)[0].n,2);
 console.log("ok: publication holding schedule row and waiting on author can complete alongside editing, without account/schedule lock inversion");
 console.log("Scheduled quota regression passed");
} finally {
 release?.();await holder?.catch(()=>{});await worker?.catch(()=>{});await editing?.catch(()=>{});
 await sql`delete from users where id=${id}::bigint`;await sql.close();
}
