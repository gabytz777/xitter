// Actual server + PostgreSQL + ffmpeg: unsent composer entities, private ownership and save/edit roundtrip.
// Contract: X ondemand.ComposeScheduling.ac2ba5b85ec22ce5a.js module651224.qq consumes
// media_key ids plus ApiImage/ApiGif URLs or the highest-bit_rate ApiVideo MP4.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const database=new URL(process.env.DATABASE_URL??"postgres://localhost/xitter");
assert(["localhost","127.0.0.1"].includes(database.hostname)&&/test|codex/.test(database.pathname),"Use a disposable local test database.");
const dir=await mkdtemp(join(tmpdir(),"xitter-unsent-media-"));
process.env.MEDIA_DIR=join(dir,"media");
const {sql,migrate}=await import("../src/db");await migrate();
const {newId}=await import("../src/ids");
const {startSession}=await import("../src/auth");
const owner=newId(),other=newId(),fixtures=[owner,other];
const probe=Bun.serve({port:0,fetch:()=>new Response()});const port=probe.port;probe.stop(true);
const origin=`http://localhost:${port}`;
const server=Bun.spawn([process.execPath,"src/server.ts"],{cwd:join(import.meta.dir,".."),env:{...process.env,PORT:String(port),PUBLIC_ORIGIN:origin,MEDIA_DIR:process.env.MEDIA_DIR,DB_POOL_MAX:"1",RATE_LIMITS:"off"},stdout:"pipe",stderr:"pipe"});
const output=new Response(server.stdout).text(),diagnostics=new Response(server.stderr).text();
let succeeded=false;
try {
 for(const id of fixtures)await sql`insert into users(id,screen_name,name,password_hash) values (${id}::bigint,${`sm${id.slice(-11)}`},'Unsent media fixture','!')`;
 const session=await startSession(owner),stranger=await startSession(other);
 const cookies=`auth_token=${session.token}; ct0=${session.csrf}`;
 const headers={cookie:cookies,"x-csrf-token":session.csrf,"content-type":"application/json"};
 const token=`xit_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex")}`;
 await sql`insert into api_tokens(id,user_id,name,token_hash,scope) values (${newId()}::bigint,${owner}::bigint,'Unsent media regression',${new Bun.CryptoHasher("sha256").update(token).digest("hex")},'write')`;
 const deadline=Date.now()+15000;
 while(true){try{if((await fetch(`${origin}/api/v1/me`,{headers:{authorization:`Bearer ${token}`}})).status===200)break;}catch{}assert(Date.now()<deadline,"Application server failed to start");await Bun.sleep(50);}
 const gql=async(op:string,variables:object,cookie=cookies)=>{
  const res=await fetch(`${origin}/i/api/graphql/q/${op}`,{method:"POST",headers:{...headers,cookie},body:JSON.stringify({variables})});assert.equal(res.status,200);const result=await res.json();assert(!result.errors,JSON.stringify(result.errors));return result;
 };
 const upload=async(mime:string,bytes:BodyInit)=>{
  const res=await fetch(`${origin}/api/v1/media`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":mime},body:bytes});assert.equal(res.status,201,await res.clone().text());return (await res.json()).data.media_id as string;
 };
 const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrlsAAAAASUVORK5CYII=","base64");
 const gif=Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==","base64");
 const photo=await upload("image/png",png),animation=await upload("image/gif",gif);
 const movie=join(dir,"source.mp4");
 const encoder=Bun.spawn([process.env.FFMPEG??"ffmpeg","-v","error","-f","lavfi","-i","color=c=blue:s=16x16:r=10","-t","0.3","-c:v","libx264","-pix_fmt","yuv420p",movie],{stdout:"ignore",stderr:"pipe"});
 assert.equal(await encoder.exited,0,await new Response(encoder.stderr).text());
 const video=await upload("video/mp4",Bun.file(movie));
 const ready=Date.now()+30000;
 while(true){const res=await fetch(`${origin}/api/v1/media/${video}`,{headers:{authorization:`Bearer ${token}`}});assert.equal(res.status,200);const state=(await res.json()).data.processing;if(state==="succeeded")break;assert.notEqual(state,"failed");assert(Date.now()<ready,"Video conversion did not finish");await Bun.sleep(50);}
 const metadata=await fetch(`${origin}/i/api/1.1/media/metadata/create.json`,{method:"POST",headers,body:JSON.stringify({media_id:photo,alt_text:{text:"A blue square 🌊"},sensitive_media_warning:["adult_content","other"]})});assert.equal(metadata.status,200);
 await sql`update media set alt_text='Animated square',sensitive_warning=array['graphic_violence'] where id=${animation}::bigint`;
 await sql`update media set alt_text='A short blue video',sensitive_warning=array['graphic_violence'] where id=${video}::bigint`;
 const request={status:"Saved media root",media_ids:[photo],thread_tweets:[{status:"Animated reply",media_ids:[animation]},{status:"Video reply",media_ids:[video]}]};
 const draft=(await gql("CreateDraftTweet",{post_tweet_request:request})).data.tweet.rest_id;
 const scheduled=(await gql("CreateScheduledTweet",{execute_at:Math.floor(Date.now()/1000)+3600,post_tweet_request:request})).data.tweet.rest_id;
 const draftList=async()=> (await gql("FetchDraftTweets",{})).data.viewer.draft_list.response_data;
 const scheduledList=async()=> (await gql("FetchScheduledTweets",{})).data.viewer.scheduled_tweet_list;
 const first=(await draftList()).find((row:any)=>row.rest_id===draft);
 const scheduledItem=(await scheduledList()).find((row:any)=>row.rest_id===scheduled);
 assert.deepEqual(first.media_entities,scheduledItem.media_entities);
 assert.deepEqual(first.media_entities.map((m:any)=>m.media_key.split("_")[1]),[photo,animation,video]);
 assert.deepEqual(first.media_entities.map((m:any)=>m.media_info.__typename),["ApiImage","ApiGif","ApiVideo"]);
 assert.equal(first.media_entities[0].media_info.alt_text,"A blue square 🌊");assert.equal(first.media_entities[0].sensitive_media_warning.adult_content,true);assert.equal(first.media_entities[0].sensitive_media_warning.other,true);
 assert.equal(first.media_entities[1].media_info.alt_text,"Animated square");assert.equal(first.media_entities[2].sensitive_media_warning.graphic_violence,true);
 // Exercise the documented client decoder contract rather than asserting our
 // own mapper's exact object shape. Every restored id must resolve to bytes.
 const restored=new Map<string,string>();
 for(const entity of first.media_entities){
  const info=entity.media_info;const id=entity.media_key.split("_")[1];
  const url=info.__typename==="ApiImage"?info.original_img_url:info.__typename==="ApiGif"?info.variants[0].url:info.variants.filter((v:any)=>v.content_type==="video/mp4").sort((a:any,b:any)=>b.bit_rate-a.bit_rate)[0].url;
  assert(url.startsWith(origin+"/media/"));
  const bytes=await fetch(url,{headers:{cookie:cookies}});assert.equal(bytes.status,200);assert.equal(bytes.headers.get("cache-control"),"private, no-store");assert((await bytes.arrayBuffer()).byteLength>0);
  const preview=await fetch(info.original_img_url,{headers:{cookie:cookies}});assert.equal(preview.status,200);assert(info.original_img_width>0&&info.original_img_height>0);
  restored.set(id,id);
 }
 assert.equal(restored.size,3);
 const edited={...first.tweet_create_request,status:"Restored edited root",media_ids:first.tweet_create_request.media_ids.map((id:string)=>restored.get(id)),thread_tweets:first.tweet_create_request.thread_tweets.map((part:any)=>({...part,media_ids:part.media_ids.map((id:string)=>restored.get(id))}))};
 await gql("EditDraftTweet",{draft_tweet_id:draft,post_tweet_request:edited});
 await gql("EditScheduledTweet",{scheduled_tweet_id:scheduled,execute_at:Math.floor(Date.now()/1000)+7200,post_tweet_request:edited});
 for(const item of [(await draftList()).find((row:any)=>row.rest_id===draft),(await scheduledList()).find((row:any)=>row.rest_id===scheduled)]){assert.equal(item.tweet_create_request.status,"Restored edited root");assert.deepEqual(item.tweet_create_request.media_ids,[photo]);assert.deepEqual(item.tweet_create_request.thread_tweets.map((part:any)=>part.media_ids),[[animation],[video]]);assert.equal(item.media_entities.length,3);}
 console.log("ok: real PNG/GIF/converted MP4 upload, owner bytes/poster, client media-key restoration, alt/warnings, draft/scheduled edit roundtrip with pool1");
 const badIds=[newId(),newId(),newId(),newId()];
 const published=newId();await sql`insert into posts(id,user_id,text,conversation_id) values (${published}::bigint,${owner}::bigint,'Published fixture',${published}::bigint)`;
 for(const [i,id]of badIds.entries())await sql`insert into media(id,user_id,kind,mime,size,width,height,state,post_id,detached,alt_text)
  values (${id}::bigint,${i===0?other:owner}::bigint,'photo','image/png',1,1,1,${i===2?'processing':'ready'},${i===1?published:null}::bigint,${i===3},${`DO NOT EXPOSE ${i}`})`;
 const bad=(await gql("CreateDraftTweet",{post_tweet_request:{status:"Stale or forged media",media_ids:badIds}})).data.tweet.rest_id;
 const filtered=(await draftList()).find((row:any)=>row.rest_id===bad);assert.equal(filtered.media_entities,undefined);assert(!JSON.stringify(filtered).includes("DO NOT EXPOSE"));
 // A duplicate id across saved draft parts has one entity, so the client can
 // restore both references without duplicate downloads or conflicting metadata.
 const duplicate=(await gql("CreateDraftTweet",{post_tweet_request:{status:"Duplicate draft media",media_ids:[photo],thread_tweets:[{status:"Duplicate reference",media_ids:[photo]}]}})).data.tweet.rest_id;
 assert.equal((await draftList()).find((row:any)=>row.rest_id===duplicate).media_entities.length,1);
 const strangerResponse=await fetch(`${origin}/i/api/graphql/q/FetchDraftTweets?variables=%7B%7D`,{headers:{cookie:`auth_token=${stranger.token}; ct0=${stranger.csrf}`,"x-csrf-token":stranger.csrf}});assert.equal(strangerResponse.status,200);assert.equal((await strangerResponse.json()).data.viewer.draft_list.response_data.length,0);
 assert.equal((await fetch(first.media_entities[0].media_info.original_img_url)).status,404,"signed-out requests cannot fetch saved media bytes");
 console.log("ok: foreign, published, processing and detached uploads omitted; duplicate references deduplicated; another account sees no drafts and signed-out bytes denied");
 succeeded=true;console.log("Scheduled composer media regression passed (HTTP/server contract validated; UI not rendered)");
} finally {
 server.kill();await server.exited;
 if(!succeeded)console.error(await output,await diagnostics);
 for(const id of fixtures)await sql`delete from users where id=${id}::bigint`;
 await sql.close();await rm(dir,{recursive:true,force:true});
}
