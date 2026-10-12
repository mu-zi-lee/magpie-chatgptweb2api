import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { browserExecutable } from './helpers.mjs';
import { sendInternal } from '../dist/internal-sender.js';
import { parseOptions } from '../dist/options.js';
import { BrowserRuntime } from '../dist/browser.js';
import { temporaryDirectory } from './helpers.mjs';

test('internal sender preflight can decline, but an attempted POST never authorizes resend', async () => {
  let mode='challenge', posts=0, preflights=0;
  let pendingResolve;
  const pendingPost=new Promise(resolve=>pendingResolve=resolve);
  const server=createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/api/auth/session'){
      if(mode==='session-limited'){res.statusCode=429;res.end('{}');return;}
      res.end(JSON.stringify({user:{id:'fixture-account'},accessToken:'FIXTURE_ONLY'}));return;
    }
    if(req.url==='/backend-api/sentinel/chat-requirements'){
      preflights++;
      res.end(JSON.stringify({token:'fixture',turnstile:{required:mode==='challenge'}}));return;
    }
    if(req.url==='/backend-api/conversation'){
      posts++;
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.messages[0].content.parts[0],'question');
      assert.equal(body.model,'fixture-model');
      if(mode==='hanging'){pendingResolve();return;}
      if(mode==='unknown'){res.statusCode=502;res.end('{}');return;}
      if(mode==='limited'){res.statusCode=429;res.end('{}');return;}
      res.setHeader('content-type','text/event-stream');
      const frame='data: '+JSON.stringify({conversation_id:'fixture-conversation',message:{id:'reply',author:{role:'assistant'},recipient:'all',content:{content_type:'text',parts:['complete reply']},end_turn:mode!=='partial',status:mode==='partial'?'in_progress':'finished_successfully'}})+'\n\n';
      res.end(frame+(mode==='delta'?'data: {"v":"missing tail","p":"/message/content/parts/0","o":"append"}\n\n':mode==='truncated'?'data: {"message":':'data: [DONE]\n\n'));return;
    }
    res.setHeader('content-type','text/html');res.end('<html></html>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser=await chromium.launch({executablePath:await browserExecutable(),headless:true});
    const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
    const send=()=>sendInternal(page,'question','fixture-model',2000,100);
    assert.equal(await send(),undefined);assert.equal(posts,0);
    await assert.rejects(sendInternal(page,'question','fixture-model',2000,100,undefined,'wrong-identity'),e=>e.code==='account_changed');
    assert.equal(posts,0);
    const beforeLimit=preflights;
    mode='session-limited';await assert.rejects(send(),e=>e.code==='upstream_rate_limit');assert.equal(posts,0);assert.equal(preflights,beforeLimit);
    mode='success';assert.equal(await send(),'complete reply');assert.equal(posts,1);
    mode='unknown';await assert.rejects(send(),e=>e.code==='internal_submission_unknown');assert.equal(posts,2);
    mode='partial';await assert.rejects(send(),e=>e.code==='internal_submission_unknown');assert.equal(posts,3);
    mode='limited';await assert.rejects(send(),e=>e.code==='upstream_rate_limit');assert.equal(posts,4);
    mode='delta';await assert.rejects(send(),e=>e.code==='internal_submission_unknown');assert.equal(posts,5);
    mode='truncated';await assert.rejects(send(),e=>e.code==='internal_submission_unknown');assert.equal(posts,6);
    mode='hanging';
    const ctl=new AbortController();
    const task=sendInternal(page,'question','fixture-model',30000,100,ctl.signal);
    await pendingPost;
    const started=Date.now();ctl.abort();
    await assert.rejects(task,e=>e.code==='cancelled');
    assert.ok(Date.now()-started<2000);
    assert.equal(page.isClosed(),true);assert.equal(posts,7);
    assert.equal(parseOptions().internalSender,false);
    assert.throws(()=>parseOptions({models:[{id:'x',label:'x',backendSlug:'invalid slug'}]}));
  } finally {await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('runtime chooses internal send or recovered browser, never both', async t => {
  for(const mode of ['success','decline','unknown','missing-composer'])await t.test(mode,async()=>{
    let posts=0, domSends=0, recover=false;
    const server=createServer(async(req,res)=>{
      if(req.url==='/api/auth/session'){res.setHeader('content-type','application/json');res.end(JSON.stringify({user:{id:'fixture-account'},accessToken:'FIXTURE_ONLY'}));return;}
      if(req.url==='/backend-api/sentinel/chat-requirements'){
        recover=true;res.setHeader('content-type','application/json');
        res.end(JSON.stringify({token:'fixture',turnstile:{required:mode==='decline'}}));return;
      }
      if(req.url==='/backend-api/conversation'){
        posts++;
        if(mode==='unknown'){res.statusCode=502;res.end('failure');return;}
        res.setHeader('content-type','text/event-stream');
        res.end('data: '+JSON.stringify({conversation_id:'fixture',message:{id:'reply',author:{role:'assistant'},content:{content_type:'text',parts:['internal complete']},status:'finished_successfully',end_turn:true}})+'\n\n');return;
      }
      if(req.url==='/sent'){domSends++;res.end('ok');return;}
      res.setHeader('content-type','text/html');
      res.end(`<html><body>${mode==='missing-composer' && recover ? '' : '<div id="prompt-textarea" contenteditable="true"> </div>'}
        ${recover ? '<button data-testid="send-button">Send</button>' : ''}<div id="messages"></div>
        <script>document.querySelector('button')?.addEventListener('click',()=>{
          fetch('/sent',{method:'POST'});
          document.querySelector('#messages').innerHTML='<article data-turn-id="user"><div data-message-author-role="user">question</div></article><article data-turn-id="assistant"><div data-message-author-role="assistant"><div class="markdown"><p>browser complete</p></div></div><button data-testid="copy-turn-action-button">Copy</button></article>';
        });</script></body></html>`);
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const temp=await temporaryDirectory();
    const runtime=new BrowserRuntime(parseOptions({profilesDir:temp.path,executablePath:await browserExecutable(),headless:true,browserMode:'managed',internalSender:true,models:[{id:'web-current',label:'fixture',backendSlug:'fixture-model'}],timeoutMs:2000,pollMs:50}),`http://127.0.0.1:${server.address().port}`);
    try {
      const {profileId}=await runtime.beginLogin();await runtime.waitLogin(profileId);
      if(mode==='missing-composer')recover=true;
      const collect=async()=>{const events=[];for await(const e of runtime.complete(profileId,{model:'web-current',prompt:'question',stream:true}))events.push(e);return events;};
      if(mode==='unknown')await assert.rejects(collect(),e=>e.code==='internal_submission_unknown');
      else {
        const events=await collect();assert.equal(events.at(-1).event,'done');
        assert.equal(events.filter(e=>e.event==='delta').map(e=>e.text).join(''),mode==='decline'?'browser complete':'internal complete');
      }
      assert.equal(posts,mode==='decline'?0:1);
      assert.equal(domSends,mode==='decline'?1:0);
    }finally{await runtime.close();await temp.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  });
});
