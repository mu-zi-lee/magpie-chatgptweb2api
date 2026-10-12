import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { writeFile, readFile, access, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { fixture, temporaryDirectory, browserExecutable } from './helpers.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const source=process.env.MAGPIE_SOURCE ?? resolve(root,'../magpie');
const host=join(source,'internal','plugin','host.js');
const bun=process.env.MAGPIE_BUN ?? 'bun';

test('unmodified Magpie Bun host: plugin login, account, text/SSE, errors and shutdown', async t => {
  await access(host);
  const temp=await temporaryDirectory(); const site=await fixture();
  const options={profilesDir:join(temp.path,'profiles'),executablePath:await browserExecutable(),headless:true,browserMode:'keep-open',pollMs:50,settleMs:150};
  // Only the site origin is replaced. Actual hooks, worker, Chromium, auth store
  // and the original Magpie host run unchanged. No personal Magpie state is read.
  await writeFile(join(temp.path,'package.json'),JSON.stringify({name:'chatgptweb-local-fixture',type:'module',main:'index.mjs'}));
  await writeFile(join(temp.path,'index.mjs'),[
    `import {createPluginHooks} from ${JSON.stringify(pathToFileURL(join(root,'dist/plugin.js')).href)};`,
    `import {BrowserBridge} from ${JSON.stringify(pathToFileURL(join(root,'dist/bridge.js')).href)};`,
    `import {parseOptions} from ${JSON.stringify(pathToFileURL(join(root,'dist/options.js')).href)};`,
    `export default {server: async (_input, options) => createPluginHooks(options, new BrowserBridge(parseOptions(options), ${JSON.stringify(site.url)}))};`,
  ].join('\n'));
  const child=spawn(bun,[host],{stdio:['pipe','pipe','pipe']});
  const pending=new Map(); let sequence=0, stderr='';
  child.stderr.setEncoding('utf8'); child.stderr.on('data',d=>{stderr+=d;});
  const input=createInterface({input:child.stdout});
  input.on('line',line=>{
    const q=JSON.parse(line); const p=pending.get(q.id); if(!p)return;
    p.frames.push(q);
    if(q.event==='chunk') child.stdin.write(JSON.stringify({method:'credit',params:{id:q.id,n:Buffer.from(q.data,'base64').length+512}})+'\n');
    if(q.error || Object.hasOwn(q,'result')) {pending.delete(q.id);clearTimeout(p.timer);q.error?p.reject(new Error(q.error.message)):p.resolve(p.frames);}
  });
  child.on('error',e=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(e);}pending.clear();});
  child.on('exit',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Magpie host exited: '+stderr));}pending.clear();});
  const rpc=(method,params)=>new Promise((resolve,reject)=>{
    const id=++sequence;
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method} timed out: ${stderr}`));},45000);
    pending.set(id,{frames:[],resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');
  });
  const result=async(method,params)=>(await rpc(method,params)).at(-1).result;
  t.after(async()=>{
    if(child.exitCode===null && child.signalCode===null) await new Promise(r=>{const timer=setTimeout(()=>{child.kill();r();},10000);child.once('exit',()=>{clearTimeout(timer);r();});child.stdin.end();});
    input.close();
    const profiles=await readdir(options.profilesDir).catch(()=>[]);
    for(const profile of profiles){
      let browser;
      try {
        const [port,path]=(await readFile(join(options.profilesDir,profile,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/);
        browser=await chromium.connectOverCDP(`ws://127.0.0.1:${port}${path}`,{noDefaults:true,timeout:3000});
        assert.ok(browser.contexts()[0].pages().length>0,'Magpie host shutdown must preserve login page');
        const session=await browser.newBrowserCDPSession();await session.send('Browser.close').catch(()=>{});
      } finally {await browser?.close().catch(()=>{});}
    }
    await new Promise(r=>setTimeout(r,700));
    await site.close();await temp.close();
  });
  const authPath=join(temp.path,'auth.json');
  const initialized=await result('init',{authPath,directory:temp.path,plugins:[{spec:'fixture-chatgptweb',target:temp.path,options}],config:{}});
  assert.equal(initialized.plugins[0].error,undefined,JSON.stringify(initialized));
  let providers=await result('providers',{});
  assert.equal(providers[0].id,'chatgpt-web');
  assert.equal(providers[0].signedIn,false);
  assert.equal(providers[0].maxConcurrency,1);
  assert.equal(providers[0].models[0].reasoning,false);
  assert.equal(providers[0].models[0].image,false);
  assert.equal(providers[0].models[0].id,'web-current');
  const auth=await result('authorize',{provider:'chatgpt-web',method:0,account:'new'});
  assert.equal(auth.method,'auto');
  assert.equal(auth.url,'');
  assert.match(auth.instructions,/专用 profile:/);
  const saved=await result('callback',{session:auth.session});
  assert.equal(saved.ok,true,JSON.stringify(saved));
  providers=await result('providers',{});
  assert.equal(providers[0].signedIn,true);
  assert.equal(providers[0].accountId,'fixture@example.invalid');
  const stored=JSON.parse(await readFile(authPath,'utf8'));
  assert.match(stored[saved.account].key,/^browser:/);
  assert.doesNotMatch(JSON.stringify(stored),/accessToken|sessionToken|Cookie/);
  const resumed=await result('authorize',{provider:'chatgpt-web',method:3,account:'new',inputs:{profileId:stored[saved.account].metadata.profileId}});
  assert.equal(resumed.url,'');
  const resumedSaved=await result('callback',{session:resumed.session});
  assert.equal(resumedSaved.ok,true,JSON.stringify(resumedSaved));
  const resumedStore=JSON.parse(await readFile(authPath,'utf8'));
  assert.equal(resumedStore[resumedSaved.account].key,stored[saved.account].key);
  const fetchText=async (body,account=saved.account)=>{
    const frames=await rpc('fetch',{provider:'chatgpt-web',account,model:'web-current',npm:'@ai-sdk/openai-compatible',url:'https://chatgpt-web.invalid/v1/chat/completions',method:'POST',body:Buffer.from(JSON.stringify(body)).toString('base64'),headers:{},window:512<<10});
    return {status:frames.find(f=>f.event==='head')?.status,body:frames.filter(f=>f.event==='chunk').map(f=>Buffer.from(f.data,'base64').toString()).join('')};
  };
  const request={model:'web-current',messages:[{role:'user',content:'从 Magpie 宿主发出的文本'}]};
  const stream=await fetchText({...request,stream:true});
  assert.equal(stream.status,200); assert.match(stream.body,/中文流式/);assert.match(stream.body,/\[DONE\]/);assert.doesNotMatch(stream.body,/OLD ANSWER/);
  const normal=await fetchText(request);
  assert.equal(normal.status,200);assert.match(JSON.parse(normal.body).choices[0].message.content,/```js/);
  const before=site.state.submissions.length;
  const unsupported=await fetchText({...request,tools:[{type:'function',function:{name:'test'}}]});
  assert.equal(unsupported.status,400);assert.equal(site.state.submissions.length,before);
  site.state.authenticated=false;
  assert.equal((await fetchText(request)).status,401);
  await result('signOut',{provider:'chatgpt-web',account:saved.account});
  assert.equal((await result('providers',{}))[0].signedIn,false);
  site.state.autoLogin=false;site.state.renderer='group';
  const guest=await result('authorize',{provider:'chatgpt-web',method:1,account:'new'});
  const guestSaved=await result('callback',{session:guest.session});
  assert.equal(guestSaved.ok,true,JSON.stringify(guestSaved));
  assert.equal((await result('providers',{}))[0].accountId,'匿名网页');
  const anonymousStream=await fetchText({...request,stream:true},guestSaved.account);
  assert.equal(anonymousStream.status,200);assert.match(anonymousStream.body,/中文流式/);assert.match(anonymousStream.body,/\[DONE\]/);
  assert.doesNotMatch(anonymousStream.body,/OLD ANSWER|THINKING/);
  await result('signOut',{provider:'chatgpt-web',account:guestSaved.account});
  site.state.authenticated=true;
  const cookieFile=join(temp.path,'cookies.json');
  await writeFile(cookieFile,JSON.stringify([{name:'fixture',value:'1',domain:'127.0.0.1',path:'/',httpOnly:true,expirationDate:Date.now()/1000+86400,sameSite:'lax'}]));
  const cookie=await result('authorize',{provider:'chatgpt-web',method:2,account:'new',inputs:{cookieFile}});
  const cookieSaved=await result('callback',{session:cookie.session});
  assert.equal(cookieSaved.ok,true,JSON.stringify(cookieSaved));
  assert.equal((await result('providers',{}))[0].accountId,'fixture@example.invalid');
  const cookieStream=await fetchText({...request,stream:true},cookieSaved.account);
  assert.equal(cookieStream.status,200);assert.match(cookieStream.body,/中文流式/);assert.match(cookieStream.body,/\[DONE\]/);
  const cookieStored=JSON.parse(await readFile(authPath,'utf8'))[cookieSaved.account];
  assert.equal(cookieStored.metadata.mode,'cookie');assert.match(cookieStored.key,/^browser:/);
  assert.equal(cookieStored.metadata.cookieFile,undefined);assert.doesNotMatch(JSON.stringify(cookieStored),/expirationDate|httpOnly|sameSite/);
  site.state.mode='verification';
  const challenged=await fetchText(request,cookieSaved.account);
  assert.equal(challenged.status,403);assert.equal(JSON.parse(challenged.body).error.code,'browser_verification_required');
  assert.equal((await result('providers',{}))[0].signedIn,true);
  site.state.mode='normal';
  await result('signOut',{provider:'chatgpt-web',account:cookieSaved.account});
});
