import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { BrowserRuntime } from '../dist/browser.js';
import { BrowserBridge } from '../dist/bridge.js';
import { parseOptions } from '../dist/options.js';
import { fixture, temporaryDirectory, browserExecutable } from './helpers.mjs';

async function observe(directory) {
  const [port,path]=(await readFile(join(directory,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/);
  return await chromium.connectOverCDP(`ws://127.0.0.1:${port}${path}`,{noDefaults:true});
}
async function terminateForTest(browser) {
  // Explicit test cleanup only. Production never issues Browser.close.
  const session=await browser.newBrowserCDPSession();
  await session.send('Browser.close').catch(()=>{});
  await browser.close().catch(()=>{});
  // Browser.close acknowledges before Chromium finishes shutdown.
  await new Promise(r=>setTimeout(r,700));
}

test('keep-open: login window survives request cleanup, idle release, runtime and worker shutdown', async t=>{
  const temp=await temporaryDirectory();const site=await fixture();
  const options=parseOptions({profilesDir:temp.path,executablePath:await browserExecutable(),headless:true,pollMs:50,settleMs:150,timeoutMs:2500,idleTimeoutMs:1000});
  let runtime=new BrowserRuntime(options,site.url);
  let observer,bridge;
  t.after(async()=>{await bridge?.close();await runtime.close();if(observer)await terminateForTest(observer);await site.close();await temp.close();});
  const {profileId}=await runtime.beginLogin();
  const directory=join(temp.path,profileId);
  observer=await observe(directory);
  const context=observer.contexts()[0];
  const loginPage=context.pages().find(p=>p.url().startsWith(site.url));
  assert.ok(loginPage,'ordinary launch must preserve a visible login page');
  await loginPage.waitForLoadState('domcontentloaded');
  assert.equal((await runtime.waitLogin(profileId)).authenticated,true);
  const initialCount=context.pages().length;
  const completion={model:'web-current',prompt:'keep-open request',stream:true};
  const collect=async()=>{const events=[];for await(const e of runtime.complete(profileId,completion))events.push(e);return events;};
  await t.test('completed requests close only their own tab',async()=>{
    assert.equal((await collect()).at(-1).event,'done');
    assert.equal(loginPage.isClosed(),false);
    await new Promise(r=>setTimeout(r,100));
    assert.equal(context.pages().length,initialCount);
  });
  await t.test('cancel stops generation and leaves login tab intact',async()=>{
    site.state.mode='timeout';
    const ctl=new AbortController();
    await assert.rejects((async()=>{for await(const event of runtime.complete(profileId,completion,ctl.signal)){if(event.event==='ready')ctl.abort();}})(),e=>e.code==='cancelled');
    assert.equal(loginPage.isClosed(),false);
    site.state.mode='normal';
  });
  await t.test('idle disconnect leaves the browser and page open; next request reconnects',async()=>{
    await new Promise(r=>setTimeout(r,1300));
    assert.equal(observer.isConnected(),true);
    assert.equal(loginPage.isClosed(),false);
    assert.equal((await collect()).at(-1).event,'done');
    assert.equal(context.pages().length,initialCount);
  });
  await t.test('runtime restart reuses authenticated browser without relaunch',async()=>{
    await runtime.close();
    assert.equal(loginPage.isClosed(),false);
    runtime=new BrowserRuntime(options,site.url);
    assert.equal((await runtime.status(profileId)).authenticated,true);
    assert.equal((await collect()).at(-1).event,'done');
    await runtime.close();
    assert.equal(loginPage.isClosed(),false);
  });
  await t.test('actual worker shutdown disconnects and next worker sends successfully',async()=>{
    bridge=new BrowserBridge(options,site.url);
    assert.equal((await bridge.call('status',{profileId})).authenticated,true);
    await bridge.close();
    assert.equal(loginPage.isClosed(),false);
    bridge=new BrowserBridge(options,site.url);
    const events=[];for await(const event of await bridge.open(profileId,completion))events.push(event);
    assert.equal(events.at(-1).event,'done');
    await bridge.close();
    assert.equal(loginPage.isClosed(),false);
    assert.equal(context.pages().length,initialCount);
  });
  await t.test('closing browser manually allows next runtime to reopen profile',async()=>{
    await terminateForTest(observer);observer=undefined;
    // Fixture deliberately retained its auth cookie from ordinary browser.
    site.state.autoLogin=false;
    runtime=new BrowserRuntime(options,site.url);
    assert.equal((await runtime.status(profileId)).authenticated,true);
    observer=await observe(directory);
    await runtime.close();
    assert.equal(observer.isConnected(),true);
  });
});

test('keep-open startup lock does not close an already running profile',async t=>{
  const temp=await temporaryDirectory();const site=await fixture();
  const options=parseOptions({profilesDir:temp.path,executablePath:await browserExecutable(),headless:true});
  const runtime=new BrowserRuntime(options,site.url);let observer;
  t.after(async()=>{await runtime.close();if(observer)await terminateForTest(observer);await site.close();await temp.close();});
  const {profileId}=await runtime.beginLogin();
  observer=await observe(join(temp.path,profileId));
  await runtime.waitLogin(profileId);await runtime.close();
  const lock=join(temp.path,profileId,'magpie-launch.lock');
  await writeFile(lock,'busy');
  const restarted=new BrowserRuntime(options,site.url);
  t.after(()=>restarted.close());
  assert.equal((await restarted.status(profileId)).authenticated,true,'existing live endpoint takes priority over launch lock');
  assert.equal(observer.isConnected(),true);
});


test('keep-open Cookie import uses same live browser in next worker and preserves login page',async t=>{
  const temp=await temporaryDirectory();const site=await fixture();
  site.state.autoLogin=false;
  const options=parseOptions({profilesDir:temp.path,executablePath:await browserExecutable(),headless:true,pollMs:50,settleMs:150});
  let bridge=new BrowserBridge(options,site.url);let observer;
  t.after(async()=>{await bridge.close();if(observer)await terminateForTest(observer);await site.close();await temp.close();});
  const cookieFile=join(temp.path,'cookies.json');
  await writeFile(cookieFile,JSON.stringify([{name:'fixture',value:'1',url:site.url}]));
  const {profileId}=await bridge.call('cookieBegin',{file:cookieFile});
  observer=await observe(join(temp.path,profileId));
  assert.equal((await bridge.call('loginWait',{profileId})).authenticated,true);
  const loginPage=observer.contexts()[0].pages()[0];
  await bridge.close();assert.equal(loginPage.isClosed(),false);
  bridge=new BrowserBridge(options,site.url);
  assert.equal((await bridge.call('status',{profileId})).windowKeptOpen,true);
  const events=[];
  for await(const event of await bridge.open(profileId,{model:'web-current',prompt:'cookie kept browser',stream:true}))events.push(event);
  assert.equal(events.at(-1).event,'done');
  await bridge.close();assert.equal(loginPage.isClosed(),false);
});

test('login timeout leaves window open and same profile can finish login later',async t=>{
  const temp=await temporaryDirectory();const site=await fixture();
  site.state.autoLogin=false;
  const options=parseOptions({profilesDir:temp.path,executablePath:await browserExecutable(),headless:true,loginTimeoutMs:1000});
  let runtime=new BrowserRuntime(options,site.url);let observer;
  t.after(async()=>{await runtime.close();if(observer)await terminateForTest(observer);await site.close();await temp.close();});
  const {profileId}=await runtime.beginLogin();observer=await observe(join(temp.path,profileId));
  const loginPage=observer.contexts()[0].pages()[0];
  await assert.rejects(runtime.waitLogin(profileId),e=>e.code==='login_timeout');
  await runtime.close();assert.equal(loginPage.isClosed(),false);
  await observer.contexts()[0].addCookies([{name:'fixture',value:'1',url:site.url}]);
  runtime=new BrowserRuntime(options,site.url);
  assert.equal((await runtime.waitLogin(profileId)).authenticated,true);
  await runtime.close();assert.equal(loginPage.isClosed(),false);
});

test('an ordinary profile without a debugging connection stays open when connection is refused',async t=>{
  const temp=await temporaryDirectory();const site=await fixture();
  const executablePath=await browserExecutable();
  const profileId='88888888-8888-4888-8888-888888888888';
  const directory=join(temp.path,profileId);
  const ordinary=await chromium.launchPersistentContext(directory,{executablePath,headless:true});
  const page=ordinary.pages()[0];await page.goto(site.url);
  await writeFile(join(directory,'magpie-profile.json'),JSON.stringify({version:1,profileId,origin:site.url,mode:'account',browserMode:'keep-open'}));
  const runtime=new BrowserRuntime(parseOptions({profilesDir:temp.path,executablePath,headless:true}),site.url);
  t.after(async()=>{await runtime.close();await ordinary.close();await site.close();await temp.close();});
  await assert.rejects(runtime.status(profileId),e=>e.code==='browser_connection_unavailable');
  assert.equal(page.isClosed(),false);
  assert.equal(await page.locator('#prompt-textarea').isVisible(),true);
  await runtime.close();assert.equal(page.isClosed(),false);
});


test('manual login follows replacement tabs and rejects changed accounts during resume',async t=>{
  const temp=await temporaryDirectory();const site=await fixture();site.state.autoLogin=false;
  const options=parseOptions({profilesDir:temp.path,executablePath:await browserExecutable(),headless:true,loginTimeoutMs:5000});
  const runtime=new BrowserRuntime(options,site.url);let observer;
  t.after(async()=>{await runtime.close();if(observer)await terminateForTest(observer);await site.close();await temp.close();});
  const {profileId}=await runtime.beginLogin();observer=await observe(join(temp.path,profileId));
  const context=observer.contexts()[0],original=context.pages()[0];
  const waiting=runtime.waitLogin(profileId);
  const replacement=await context.newPage();
  await replacement.goto(site.url);await original.close();
  await context.addCookies([{name:'fixture',value:'1',url:site.url}]);
  assert.equal((await waiting).authenticated,true);
  assert.equal((await runtime.beginLogin(undefined,profileId)).profileId,profileId);
  site.state.identity='different-account';
  await assert.rejects(runtime.waitLogin(profileId),e=>e.code==='account_changed');
  assert.equal(replacement.isClosed(),false);
});

test('anonymous profiles cannot silently become account profiles through resume',async t=>{
  const temp=await temporaryDirectory();const site=await fixture();site.state.authenticated=false;site.state.autoLogin=false;
  const options=parseOptions({profilesDir:temp.path,executablePath:await browserExecutable(),headless:true});
  const runtime=new BrowserRuntime(options,site.url);let observer;
  t.after(async()=>{await runtime.close();if(observer)await terminateForTest(observer);await site.close();await temp.close();});
  const {profileId}=await runtime.beginGuest();observer=await observe(join(temp.path,profileId));
  await runtime.waitGuest(profileId);
  await assert.rejects(runtime.beginLogin(undefined,profileId),e=>e.code==='profile_mode_mismatch');
  await assert.rejects(runtime.waitLogin(profileId),e=>e.code==='profile_mode_mismatch');
  assert.equal(observer.contexts()[0].pages()[0].isClosed(),false);
});

test('separate workers serialize one profile and release it after cancellation without closing login',async t=>{
  const temp=await temporaryDirectory();const site=await fixture();
  const options=parseOptions({profilesDir:temp.path,executablePath:await browserExecutable(),headless:true,pollMs:50,settleMs:150});
  const runtime=new BrowserRuntime(options,site.url);let observer;
  const first=new BrowserBridge(options,site.url),second=new BrowserBridge(options,site.url);
  t.after(async()=>{await first.close();await second.close();await runtime.close();if(observer)await terminateForTest(observer);await site.close();await temp.close();});
  const {profileId}=await runtime.beginLogin();await runtime.waitLogin(profileId);
  observer=await observe(join(temp.path,profileId));const loginPage=observer.contexts()[0].pages()[0];
  await runtime.close();site.state.mode='timeout';
  const source=await first.open(profileId,{model:'web-current',prompt:'serialized request',stream:true});
  assert.equal((await source.next()).value.event,'ready');
  const before=site.state.submissions.length;
  await assert.rejects(second.call('status',{profileId}),e=>e.code==='account_busy'&&e.status===429);
  const blocked=await second.open(profileId,{model:'web-current',prompt:'must not submit',stream:true});
  await assert.rejects(blocked.next(),e=>e.code==='account_busy');
  assert.equal(site.state.submissions.length,before);
  await source.return();await first.close();site.state.mode='normal';
  assert.equal((await second.call('status',{profileId})).authenticated,true);
  const events=[];for await(const event of await second.open(profileId,{model:'web-current',prompt:'after cancellation',stream:true}))events.push(event);
  assert.equal(events.at(-1).event,'done');
  assert.equal(loginPage.isClosed(),false);
});
