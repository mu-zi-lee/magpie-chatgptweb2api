import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeCookies, parseCookieHeader, readCookieFile } from '../dist/cookies.js';
import { BrowserRuntime } from '../dist/browser.js';
import { BrowserBridge } from '../dist/bridge.js';
import { parseOptions } from '../dist/options.js';
import { fixture, temporaryDirectory, browserExecutable } from './helpers.mjs';

const exported = {name:'__Secure-next-auth.session-token',value:'TEST_COOKIE_VALUE',domain:'.chatgpt.com',path:'/',httpOnly:true,secure:true,sameSite:'no_restriction',expirationDate:2000000000,hostOnly:false,session:false,storeId:'0'};

test('Cookie request headers preserve split tokens and encoded values without inventing expiration',()=>{
  const cookies=parseCookieHeader('Cookie: oai-did=device; __Secure-next-auth.session-token.0=TOKEN=a==; __Secure-next-auth.session-token.1=TOKEN%2Fb; __Host-next-auth.csrf-token=CSRF%7Chash; empty=;');
  assert.equal(cookies.length,5);assert.equal(cookies[1].value,'TOKEN=a==');assert.equal(cookies[2].value,'TOKEN%2Fb');
  assert.equal(cookies[1].httpOnly,true);assert.equal(cookies[0].httpOnly,false);
  assert.ok(cookies.every(c=>c.domain==='chatgpt.com'&&c.path==='/'&&c.secure===true&&c.expires===undefined));
  for(const input of ['token=FIRST; token=SECOND','not-a-cookie','token=VALUE\r\nAuthorization: secret']) {
    assert.throws(()=>parseCookieHeader(input),e=>e.code==='invalid_cookie_file'&&!e.message.includes('secret'));
  }
});

test('Cookie exports retain auth attributes and support arrays or cookies envelopes',()=>{
  const cookies=normalizeCookies([{...exported},{...exported,domain:'.example.invalid'}]);
  assert.deepEqual(cookies,[{name:exported.name,value:exported.value,domain:'.chatgpt.com',path:'/',httpOnly:true,secure:true,sameSite:'None',expires:2000000000}]);
  assert.deepEqual(normalizeCookies({cookies:[exported],origins:[{origin:'https://example.invalid',localStorage:[]}]}),cookies);
  const session=normalizeCookies([{...exported,domain:'chatgpt.com',session:true,expires:-1,sameSite:'unspecified',hostOnly:true}]);
  assert.equal(session[0].domain,'chatgpt.com');assert.equal(session[0].expires,undefined);assert.equal(session[0].sameSite,undefined);
});

test('unrelated websites, expired credentials and malformed exports cannot create a login',()=>{
  for(const domain of ['evilchatgpt.com','.chatgpt.com.evil.invalid','auth.openai.com']) {
    assert.throws(()=>normalizeCookies([{...exported,domain}]),e=>e.code==='cookie_file_empty');
  }
  assert.throws(()=>normalizeCookies([{...exported,expirationDate:1}]),e=>e.code==='cookie_file_empty');
  for(const entry of [{...exported,value:123},{...exported,path:'relative'},{...exported,sameSite:'unknown'},{...exported,expirationDate:'tomorrow'}]) {
    assert.throws(()=>normalizeCookies([entry]),e=>e.code==='invalid_cookie_file'&&!e.message.includes('TEST_COOKIE_VALUE'));
  }
});

test('local Cookie file errors stay bounded and never echo credential contents',async t=>{
  const temp=await temporaryDirectory();t.after(()=>temp.close());
  const file=join(temp.path,'cookies.json');
  await writeFile(file,'[{"value":"DO_NOT_ECHO_CREDENTIAL" broken JSON');
  await assert.rejects(readCookieFile(file),e=>e.code==='invalid_cookie_file'&&!e.message.includes('DO_NOT_ECHO_CREDENTIAL'));
  await writeFile(file,'x'.repeat(1024*1024+1));
  await assert.rejects(readCookieFile(file),e=>e.code==='invalid_cookie_file');
  await assert.rejects(readCookieFile(join(temp.path,'missing.json')),e=>e.code==='cookie_file_unreadable');
  await assert.rejects(readCookieFile('cookies.json'),e=>e.code==='cookie_file_required');
});

test('real Chromium Cookie import authenticates, survives restart and never falls back to guest',async t=>{
  const temp=await temporaryDirectory();const site=await fixture();site.state.autoLogin=false;
  const options=parseOptions({profilesDir:join(temp.path,'profiles'),executablePath:await browserExecutable(),headless:true,browserMode:'managed',pollMs:50,settleMs:150,loginTimeoutMs:1000});
  let runtime=new BrowserRuntime(options,site.url);
  t.after(async()=>{await runtime.close();await site.close();await temp.close();});
  const file=join(temp.path,'cookies.json');
  await writeFile(file,JSON.stringify([{name:'fixture',value:'1',domain:'127.0.0.1',path:'/',httpOnly:true,secure:false,sameSite:'lax',expirationDate:Date.now()/1000+86400}]));
  const {profileId}=await runtime.beginCookieLogin(file);
  assert.equal((await runtime.waitLogin(profileId)).authenticated,true);
  const marker=JSON.parse(await readFile(join(options.profilesDir,profileId,'magpie-profile.json'),'utf8'));
  assert.equal(marker.mode,'account');assert.ok(marker.identity);assert.equal(marker.cookieFile,undefined);
  const events=[];for await(const e of runtime.complete(profileId,{model:'web-current',prompt:'Cookie 文本验证',stream:true}))events.push(e);
  assert.equal(events.at(-1).event,'done');assert.match(events.filter(e=>e.event==='delta').map(e=>e.text).join(''),/中文流式/);
  await rm(file);await runtime.close();runtime=new BrowserRuntime(options,site.url);
  assert.equal((await runtime.status(profileId)).authenticated,true,'saved browser session must not reread the export file');
  site.state.authenticated=false;
  await assert.rejects(runtime.status(profileId),e=>e.code==='sign_in_required');
});

test('unrecognized imported cookies never mark an anonymous input box as account login',async t=>{
  const temp=await temporaryDirectory();const site=await fixture();site.state.autoLogin=false;
  const runtime=new BrowserRuntime(parseOptions({profilesDir:join(temp.path,'profiles'),executablePath:await browserExecutable(),headless:true,browserMode:'managed',loginTimeoutMs:1000}),site.url);
  t.after(async()=>{await runtime.close();await site.close();await temp.close();});
  const file=join(temp.path,'cookies.json');
  await writeFile(file,JSON.stringify([{name:'irrelevant',value:'UNRECOGNIZED_COOKIE',domain:'127.0.0.1',path:'/'}]));
  const {profileId}=await runtime.beginCookieLogin(file);
  await assert.rejects(runtime.waitLogin(profileId),e=>e.code==='login_timeout'&&!e.message.includes('UNRECOGNIZED_COOKIE'));
  await assert.rejects(runtime.status(profileId),e=>e.code==='sign_in_required');
});

test('private worker reads Cookie exports locally and returns only the account association',async t=>{
  const temp=await temporaryDirectory();const site=await fixture();site.state.autoLogin=false;
  const bridge=new BrowserBridge(parseOptions({profilesDir:join(temp.path,'profiles'),executablePath:await browserExecutable(),headless:true,browserMode:'managed'}),site.url);
  t.after(async()=>{await bridge.close();await site.close();await temp.close();});
  const file=join(temp.path,'cookies.json');
  await writeFile(file,JSON.stringify({cookies:[{name:'fixture',value:'1',domain:'127.0.0.1',path:'/',expires:Date.now()/1000+86400,httpOnly:true}]}));
  const result=await bridge.call('cookieBegin',{file});
  assert.deepEqual(Object.keys(result),['profileId']);
  const status=await bridge.call('loginWait',result);
  assert.equal(status.authenticated,true);assert.equal(status.cookies,undefined);
});

test('403 session checks can use current server bootstrap without exporting its token',async t=>{
  const temp=await temporaryDirectory();const site=await fixture();site.state.autoLogin=false;site.state.authStatus=403;site.state.bootstrap=true;
  const options=parseOptions({profilesDir:join(temp.path,'profiles'),executablePath:await browserExecutable(),headless:true,browserMode:'managed',loginTimeoutMs:1000});
  const runtime=new BrowserRuntime(options,site.url);
  t.after(async()=>{await runtime.close();await site.close();await temp.close();});
  const file=join(temp.path,'cookies.txt');await writeFile(file,'Cookie: fixture=1; preference=value');
  const {profileId}=await runtime.beginCookieLogin(file);
  const status=await runtime.waitLogin(profileId);
  assert.equal(status.authenticated,true);assert.doesNotMatch(JSON.stringify(status),/FIXTURE_ONLY_DO_NOT_TRANSFER|accessToken/);
  site.state.identity='changed-account';await assert.rejects(runtime.status(profileId),e=>e.code==='account_changed');
  site.state.authenticated=false;await assert.rejects(runtime.status(profileId),e=>e.code==='sign_in_required');
  site.state.authenticated=true;site.state.identity='fixture-account';site.state.authStatus=200;
  assert.equal((await runtime.status(profileId)).authenticated,true);
});

test('a browser verification page reports its own error and never submits text',async t=>{
  const temp=await temporaryDirectory();const site=await fixture();
  const runtime=new BrowserRuntime(parseOptions({profilesDir:join(temp.path,'profiles'),executablePath:await browserExecutable(),headless:true,browserMode:'managed'}),site.url);
  t.after(async()=>{await runtime.close();await site.close();await temp.close();});
  const {profileId}=await runtime.beginLogin();await runtime.waitLogin(profileId);
  site.state.mode='verification';const before=site.state.submissions.length;
  await assert.rejects(runtime.status(profileId),e=>e.status===403&&e.code==='browser_verification_required');
  await assert.rejects((async()=>{for await(const e of runtime.complete(profileId,{model:'web-current',prompt:'must not submit',stream:true})){}})(),e=>e.status===403&&e.code==='browser_verification_required');
  assert.equal(site.state.submissions.length,before);
  site.state.mode='normal';assert.equal((await runtime.status(profileId)).authenticated,true);
});
