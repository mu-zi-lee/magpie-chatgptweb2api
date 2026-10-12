import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../dist/browser.js';
import { BrowserBridge } from '../dist/bridge.js';
import { parseOptions } from '../dist/options.js';
import { fixture, temporaryDirectory, browserExecutable } from './helpers.mjs';

test('real browser isolates turns, streams Markdown, detects errors, cancels and preserves login', async t => {
  const temp = await temporaryDirectory();
  const site = await fixture();
  const options = parseOptions({profilesDir:temp.path, executablePath:await browserExecutable(), headless:true,browserMode:'managed', pollMs:50, settleMs:150, timeoutMs:2000, idleTimeoutMs:1000});
  let runtime = new BrowserRuntime(options, site.url);
  t.after(async () => { await runtime.close(); await site.close(); await temp.close(); });
  const {profileId} = await runtime.beginLogin();
  assert.equal((await runtime.waitLogin(profileId)).authenticated,true);
  const completion = {model:'web-current',prompt:'你好',stream:true};
  const collect = async () => { const events=[]; for await (const e of runtime.complete(profileId,completion)) events.push(e); return events; };
  await t.test('stream contains new reply and fenced code, never historical reply', async () => {
    const events = await collect();
    const deltas = events.filter(e => e.event==='delta');
    assert.ok(deltas.length>=2,'must produce an intermediate block before completion');
    const text = deltas.map(e=>e.text).join('');
    assert.match(text,/第一段：中文流式/);
    assert.match(text,/```js\nconst x = 1;\n```/);
    assert.match(text,/\*\*完成\*\*/);
    assert.doesNotMatch(text,/OLD ANSWER/);
    assert.equal(events.at(-1).event,'done');
  });
  await t.test('absence of Stop before generation starts is not completion', async () => {
    site.state.mode='delayed-start';
    const started=Date.now();
    const events=await collect();
    assert.ok(Date.now()-started >=1000);
    assert.equal(events.filter(e=>e.event==='delta').map(e=>e.text).join(''),'最终完整回复');
  });
  await t.test('rate limits are preserved', async () => {
    site.state.mode='rate-limit';
    await assert.rejects(collect(), e=>e.status===429 && e.code==='upstream_rate_limit');
  });
  await t.test('rewritten committed text fails, rather than returning corrupted Markdown', async () => {
    site.state.mode='rewrite';
    await assert.rejects(collect(),e=>e.code==='stream_rewritten');
  });
  await t.test('abort clicks Stop and releases the account lock', async () => {
    site.state.mode='timeout';
    const ctl=new AbortController();
    const task=(async()=>{ for await (const e of runtime.complete(profileId,completion,ctl.signal)) { if(e.event==='ready') setTimeout(()=>ctl.abort(),250); } })();
    await assert.rejects(task,e=>e.code==='cancelled');
    await new Promise(r=>setTimeout(r,150));
    assert.ok(site.state.stops>0);
    site.state.mode='normal';
    assert.equal((await collect()).at(-1).event,'done');
  });
  await t.test('a concurrent call on the same account is rejected', async () => {
    site.state.mode='timeout';
    const stream=runtime.complete(profileId,completion);
    assert.equal((await stream.next()).value.event,'ready');
    await assert.rejects(runtime.status(profileId),e=>e.status===429);
    await stream.return();
    site.state.mode='normal';
  });
  await t.test('persistent browser profile works after process-level runtime restart', async () => {
    site.state.autoLogin=false;
    await runtime.close();
    runtime=new BrowserRuntime(options,site.url);
    assert.equal((await runtime.status(profileId)).authenticated,true);
  });
  await t.test('a timed out response is an error and attempts Stop', async () => {
    site.state.mode='timeout';
    const stops=site.state.stops;
    await assert.rejects(collect(),e=>e.status===504 && e.code==='generation_timeout');
    await new Promise(r=>setTimeout(r,100));
    assert.ok(site.state.stops>stops);
    site.state.mode='normal';
  });
  await t.test('account changes and expired authentication cannot silently submit', async () => {
    const before=site.state.submissions.length;
    site.state.identity='another-account';
    await assert.rejects(collect(),e=>e.code==='account_changed');
    site.state.identity='fixture-account'; site.state.authenticated=false;
    await assert.rejects(collect(),e=>e.status===401);
    assert.equal(site.state.submissions.length,before);
    site.state.authenticated=true;
  });
  await t.test('unavailable configured model fails before Send', async () => {
    await runtime.close();
    runtime=new BrowserRuntime(parseOptions({...options,models:[{id:'missing',label:'Missing',pickerLabel:'Does not exist'}]}),site.url);
    const before=site.state.submissions.length;
    await assert.rejects((async()=>{for await (const e of runtime.complete(profileId,{...completion,model:'missing'})) {} })(),e=>e.code==='model_unavailable');
    assert.equal(site.state.submissions.length,before);
  });
});

test('private worker supports actual browser login and streaming under Node', async t => {
  const temp=await temporaryDirectory(); const site=await fixture();
  const bridge=new BrowserBridge(parseOptions({profilesDir:temp.path,executablePath:await browserExecutable(),headless:true,browserMode:'managed',pollMs:50,settleMs:150}),site.url);
  t.after(async()=>{await bridge.close();await site.close();await temp.close();});
  const {profileId}=await bridge.call('loginBegin',{});
  await bridge.call('loginWait',{profileId});
  const source=await bridge.open(profileId,{model:'web-current',prompt:'through worker',stream:true});
  const events=[]; for await(const e of source) events.push(e);
  assert.equal(events[0].event,'ready'); assert.equal(events.at(-1).event,'done');
  assert.match(events.filter(e=>e.event==='delta').map(e=>e.text).join(''),/中文流式/);
  await bridge.close();
});

test('anonymous grouped renderer binds replies and ignores user Copy and thinking', async t => {
  const temp=await temporaryDirectory(); const site=await fixture();
  site.state.authenticated=false; site.state.autoLogin=false; site.state.renderer='group';
  const options=parseOptions({profilesDir:temp.path,executablePath:await browserExecutable(),headless:true,browserMode:'managed',pollMs:50,settleMs:150,timeoutMs:2000});
  let runtime=new BrowserRuntime(options,site.url);
  t.after(async()=>{await runtime.close();await site.close();await temp.close();});
  const {profileId}=await runtime.beginGuest();
  assert.equal((await runtime.waitGuest(profileId)).anonymous,true);
  const collect=async()=>{const events=[];for await(const e of runtime.complete(profileId,{model:'web-current',prompt:'匿名文本',stream:true}))events.push(e);return events;};
  const text=events=>events.filter(e=>e.event==='delta').map(e=>e.text).join('');
  await t.test('anonymous text streams only the new answer',async()=>{
    const events=await collect();
    assert.match(text(events),/中文流式/);
    assert.doesNotMatch(text(events),/OLD ANSWER|THINKING|匿名文本/);
    assert.equal(events.at(-1).event,'done');
  });
  await t.test('user Copy cannot finish a delayed reply',async()=>{
    site.state.mode='delayed-start';const started=Date.now();
    assert.equal(text(await collect()),'最终完整回复');
    assert.ok(Date.now()-started>=1000);
  });
  await t.test('anonymous profile is reusable after restart',async()=>{
    await runtime.close();runtime=new BrowserRuntime(options,site.url);
    assert.equal((await runtime.status(profileId)).anonymous,true);
  });
  await t.test('signing into a guest profile is rejected before submission',async()=>{
    site.state.authenticated=true;site.state.autoLogin=true;
    const before=site.state.submissions.length;
    await assert.rejects(collect(),e=>e.code==='account_changed');
    assert.equal(site.state.submissions.length,before);
  });
});

test('anonymous lightweight page supports completion markers and the shared Send/Stop button', async t => {
  const temp=await temporaryDirectory();const site=await fixture();
  site.state.authenticated=false;site.state.autoLogin=false;site.state.renderer='mobile';
  const runtime=new BrowserRuntime(parseOptions({profilesDir:temp.path,executablePath:await browserExecutable(),headless:true,browserMode:'managed',pollMs:50,settleMs:150,timeoutMs:2000}),site.url);
  t.after(async()=>{await runtime.close();await site.close();await temp.close();});
  const {profileId}=await runtime.beginGuest();await runtime.waitGuest(profileId);
  const completion={model:'web-current',prompt:'轻量匿名文本',stream:true};
  const collect=async()=>{const events=[];for await(const e of runtime.complete(profileId,completion))events.push(e);return events;};
  await t.test('empty pending IDs can be replaced, while remounted history and attribution stay excluded',async()=>{
    const events=await collect();const text=events.filter(e=>e.event==='delta').map(e=>e.text).join('');
    assert.match(text,/中文流式/);assert.match(text,/```js/);
    assert.doesNotMatch(text,/OLD ANSWER|ChatGPT 说|轻量匿名文本/);
    assert.ok(events.filter(e=>e.event==='delta').length>=2);
    assert.equal(events.at(-1).event,'done');
  });
  await t.test('the explicit completion flag waits through delayed generation',async()=>{
    site.state.mode='delayed-start';
    const events=await collect();
    assert.equal(events.filter(e=>e.event==='delta').map(e=>e.text).join(''),'最终完整回复');
  });
  await t.test('cancellation clicks the same button in its Stop state',async()=>{
    site.state.mode='timeout';const ctl=new AbortController();const stops=site.state.stops;
    await assert.rejects((async()=>{for await(const e of runtime.complete(profileId,completion,ctl.signal)){if(e.event==='ready')setTimeout(()=>ctl.abort(),250);}})(),e=>e.code==='cancelled');
    await new Promise(r=>setTimeout(r,100));assert.ok(site.state.stops>stops);
  });
});
