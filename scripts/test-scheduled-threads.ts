// Real PostgreSQL scheduled-thread publication, rollback, workers and connection-loss regression.
// DATABASE_URL must point at a dedicated migrated local test database.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Viewer } from "../src/auth";
import { sql } from "../src/db";
import { newId } from "../src/ids";
import { PostError, createPost } from "../src/posts";
import { runDue, scheduledHandlers as h } from "../src/scheduled";
const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");
const user = newId(), other = newId(), suffix = randomBytes(5).toString("hex");
const v = { id: user } as Viewer;
const at = Math.floor(Date.now()/1000)+3600;
const make = async (request: any) => (await h.CreateScheduledTweet(v,{execute_at:at,post_tweet_request:request})).data.tweet.rest_id;
const due = async (id: string, attempts = 0) => sql`update scheduled_posts set execute_at=now()-interval '1 second', attempts=${attempts} where id=${id}::bigint`;
const posts = (prefix: string) => sql`select id::text, text, reply_to_id::text, conversation_id::text, quote_id::text, sensitive from posts where user_id=${user}::bigint and text like ${`${prefix}%`} order by id`;
const schedule = async (id: string) => (await sql`select id::text,kind,request,attempts,last_error,execute_at from scheduled_posts where id=${id}::bigint`)[0];
const upload = async (owner = user, kind = "photo") => {
 const id=newId();
 await sql`insert into media(id,user_id,kind,mime,size,width,height,state) values (${id}::bigint,${owner}::bigint,${kind},${kind === "video" ? "video/mp4" : "image/png"},10,10,10,'ready')`;
 return id;
};
const trigger = `scheduled_failure_${suffix}`;
let triggerCreated=false;
let blockedWorker: Promise<number> | undefined;
let blocker: Awaited<ReturnType<typeof sql.reserve>> | undefined;
async function removeTrigger() {
 if(!triggerCreated) return;
 await sql.unsafe(`drop trigger if exists ${trigger} on posts`);
 await sql.unsafe(`drop function if exists ${trigger}()`); triggerCreated=false;
}
async function rejects(fn:()=>Promise<unknown>,code:number) {await assert.rejects(fn,(e:unknown)=>e instanceof PostError && e.code===code);}
try {
 for(const id of [user,other]) await sql`insert into users(id,screen_name,name,password_hash) values (${id}::bigint,${`scheduled_${id}`},'Scheduled fixture','!')`;
 await rejects(()=>make({status:"valid root",thread_tweets:[{status:" "}]}),170);
 await rejects(()=>make({status:"valid root",thread_tweets:[{status:"x".repeat(5000)}]}),186);
 await rejects(()=>make({status:"valid root",thread_tweets:[null]}),170);
 await rejects(()=>make({status:"valid root",thread_tweets:Array.from({length:26},()=>({status:"overflow"}))}),186);
 const duplicateMedia=await upload();
 await rejects(()=>make({status:"root",media_ids:[duplicateMedia],thread_tweets:[{status:"reply",media_ids:[duplicateMedia]}]}),186);
 const invalidEdit=await make({status:"original",thread_tweets:[{status:"original reply"}]});
 await rejects(()=>h.EditScheduledTweet(v,{scheduled_tweet_id:invalidEdit,execute_at:at,post_tweet_request:{status:"valid root",thread_tweets:[{status:" "}]}}),170);
 assert.equal((await schedule(invalidEdit)).request.thread_tweets[0].status,"original reply");
 await h.DeleteScheduledTweet(v,{scheduled_tweet_id:invalidEdit});
 const parent=await createPost(user,"parent fixture"), quote=await createPost(other,"quoted fixture");
 const photo=await upload(), video=await upload(user,"video");
 const request={status:"complete root",media_ids:[photo],in_reply_to_status_id:parent,thread_tweets:[{status:"complete middle",attachment_url:`https://example.test/u/status/${quote}`,richtext_options:{richtext_tags:[]}},{status:"complete end",media_ids:[video],possibly_sensitive:true}]};
	const complete=await make(request);
	const listed=(await h.FetchScheduledTweets(v)).data.viewer.scheduled_tweet_list.find((item:any)=>item.rest_id===complete)!;
	assert.equal(listed.tweet_create_request.type,"PostTweetRequest","the client's unsent-list renderer requires the request discriminator");
	assert.deepEqual(listed.tweet_create_request.thread_tweets[0].richtext_options,{richtext_tags:[]},"retain editing metadata for thread replies");
	await due(complete);
 assert.equal(await runDue(),1);
 const published=await posts("complete"); assert.equal(published.length,3);
 assert.deepEqual(published.map((p:any)=>p.text),["complete root","complete middle","complete end"]);
 assert.deepEqual(published.map((p:any)=>p.reply_to_id),[parent,published[0].id,published[1].id]);
 assert(published.every((p:any)=>p.conversation_id===parent)); assert.equal(published[1].quote_id,quote);assert.equal(published[2].sensitive,true);
 assert.equal((await sql`select post_id::text from media where id=${photo}::bigint`)[0].post_id,published[0].id);
 assert.equal((await sql`select post_id::text from media where id=${video}::bigint`)[0].post_id,published[2].id);
 assert.equal(await schedule(complete),undefined); assert.equal(await runDue(),0);
 console.log("ok: complete thread preserves root reply, self reply chain, per-item quote/photo/video/sensitivity and executes once");
 const failedPhoto=await upload();
 const retry=await make({status:"retry root",media_ids:[failedPhoto],thread_tweets:[{status:"retry fail"}]});
 await sql.unsafe(`create function ${trigger}() returns trigger language plpgsql as $$ begin if new.user_id = ${user} and new.text in ('retry fail','exhaust fail') then raise exception 'fixture scheduled second insert failed'; end if; return new; end $$`);
 await sql.unsafe(`create trigger ${trigger} before insert on posts for each row execute function ${trigger}()`);triggerCreated=true;
 await due(retry); await runDue();
 assert.equal((await posts("retry")).length,0,"later insertion failure rolls back earlier post");
 assert.equal((await sql`select post_id from media where id=${failedPhoto}::bigint`)[0].post_id,null,"earlier attachment rolls back");
 assert.equal((await schedule(retry)).attempts,1);assert.equal((await schedule(retry)).kind,"scheduled");assert.match((await schedule(retry)).last_error,/fixture scheduled/);
 const exhaustedRequest={status:"exhaust root",thread_tweets:[{status:"exhaust fail"}]};
 const exhausted=await make(exhaustedRequest);await due(exhausted,5);await runDue();
 assert.equal((await posts("exhaust")).length,0);assert.equal((await schedule(exhausted)).kind,"draft");
 assert.equal((await schedule(exhausted)).execute_at,null);assert.equal((await schedule(exhausted)).request.thread_tweets[0].status,"exhaust fail");
 await removeTrigger();await due(retry);await runDue();assert.equal((await posts("retry")).length,2);assert.equal(await schedule(retry),undefined);
 console.log("ok: forced second-insert failure rolls back posts and attachments; retries publish once; exhausted thread rescued as one intact draft");
	const foreignUpload=await upload(other);
	const refusedRequest={status:"refused root",thread_tweets:[{status:"refused end",media_ids:[foreignUpload]}]};
	await rejects(()=>make(refusedRequest),186);
	// Old queued data and ownership changes must still be handled safely at execution.
	const refused=await make({status:"refused root",thread_tweets:[{status:"refused end"}]});
	await sql`update scheduled_posts set request=${JSON.stringify(refusedRequest)}::text::jsonb where id=${refused}::bigint`;
	await due(refused);await runDue();
 assert.equal((await posts("refused")).length,0);assert.equal((await schedule(refused)).kind,"draft");assert.equal((await schedule(refused)).request.thread_tweets[0].media_ids[0],foreignUpload);
 const moderation=await make({status:"moderation root",thread_tweets:[{status:"moderation tail"}]});
 await sql`update scheduled_posts set request=jsonb_set(request,'{thread_tweets,0,status}','"kill all trans people"'::jsonb) where id=${moderation}::bigint`;
 await due(moderation);await runDue();assert.equal((await posts("moderation")).length,0);assert.equal((await schedule(moderation)).kind,"draft");
 assert((await sql`select 1 from audit_log where target=${user} and action in ('automod_second_chance','automod_strike')`).length>0,"refusal preserves committed moderation side effects");
 console.log("ok: unavailable media and rejected later text preserve full drafts, publish no partial root and keep safety actions committed");
 for(let i=0;i<8;i++){const id=await make({status:`workers ${i} root`,thread_tweets:[{status:`workers ${i} end`}]});await due(id);}
 const workers=await Promise.all([runDue(),runDue(),runDue()]); assert.equal(workers.reduce((a,b)=>a+b,0),8);assert.equal((await posts("workers")).length,16);
 assert.equal(await runDue(),0);
 console.log("ok: concurrent workers claim eight threads once with no duplicates");
 // Block the second insert inside publication, terminate its actual PG backend,
 // then verify both first post and claim rolled back before another run retries.
 const crash=await make({status:"crash root",thread_tweets:[{status:"crash end"}]});await due(crash);
 const key=Number(user.slice(-8));
 await sql.unsafe(`create function ${trigger}() returns trigger language plpgsql as $$ begin if new.user_id = ${user} and new.text = 'crash end' then perform pg_advisory_xact_lock(${key}); end if; return new; end $$`);
 await sql.unsafe(`create trigger ${trigger} before insert on posts for each row execute function ${trigger}()`);triggerCreated=true;
 blocker=await sql.reserve();await blocker`select pg_advisory_lock(${key})`;
 blockedWorker=runDue();const failed=assert.rejects(blockedWorker);
 const deadline=Date.now()+10000;let pid:number|undefined;
	while(!pid){const rows=await sql`select a.pid from pg_stat_activity a join pg_locks l on l.pid=a.pid
		where a.datname=current_database() and a.wait_event='advisory' and a.query like 'insert into posts%'
		and l.locktype='advisory' and l.classid=0 and l.objid=${key}::oid and not l.granted`;pid=rows[0]?.pid;assert(Date.now()<deadline,"scheduler did not block in second insert");if(!pid)await Bun.sleep(10);}
 assert.equal((await posts("crash")).length,0,"uncommitted partial thread never visible");
 await sql`select pg_terminate_backend(${pid})`;await failed;
 await blocker`select pg_advisory_unlock(${key})`;blocker.release();blocker=undefined;
 await removeTrigger();assert.equal((await posts("crash")).length,0);assert.equal((await schedule(crash)).kind,"scheduled");
 await runDue();assert.equal((await posts("crash")).length,2);assert.equal(await schedule(crash),undefined);
 console.log("ok: lost database connection rolls back partial publication and queue claim; next worker publishes entire thread once");
	const drafts=(await h.FetchDraftTweets(v)).data.viewer.draft_list.response_data;
	assert.equal(drafts.filter((d:any)=>[exhausted,refused,moderation].includes(d.rest_id)).length,3);
	await sql`update scheduled_posts set request=request || '{"type":"unexpected"}'::jsonb where id=${exhausted}::bigint`;
	assert.equal((await h.FetchDraftTweets(v)).data.viewer.draft_list.response_data.find((d:any)=>d.rest_id===exhausted)!.tweet_create_request.type,"PostTweetRequest","stored values cannot override the required request type");
 assert.equal(await runDue(),0,"rescued drafts never republish automatically");
 console.log("Scheduled thread regression passed");
} finally {
 if(blocker){await blocker`select pg_advisory_unlock_all()`.catch(()=>{});blocker.release();}
 await blockedWorker?.catch(()=>{});await removeTrigger();
 await sql`delete from audit_log where target in (${user},${other})`;
 await sql`delete from users where id in (${user}::bigint,${other}::bigint)`;
 await sql.close();
}
