import test from 'node:test';
import assert from 'node:assert/strict';
import { projectReply, readInternalReply } from '../dist/internal-reader.js';
import { parseOptions } from '../dist/options.js';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { browserExecutable } from './helpers.mjs';
import { temporaryDirectory } from './helpers.mjs';
import { BrowserRuntime } from '../dist/browser.js';

const user = {message:{id:'submitted',author:{role:'user'}}};
const answer = (text='answer', extra={}) => ({parent:'u',message:{author:{role:'assistant'},recipient:'all',content:{content_type:'text',parts:[text]},end_turn:true,status:'finished_successfully',...extra}});

test('internal reader anchors the exact user and requires explicit successful completion', () => {
  assert.deepEqual(projectReply({mapping:{u:user,a:answer(),old:{...answer('stale'),parent:'other'}}},'submitted',100),{text:'answer',complete:true});
  assert.equal(projectReply({mapping:{u:user,a:answer()}},'missing',100),undefined);
  assert.equal(projectReply({mapping:{u:user,a:answer('partial',{end_turn:false})}},'submitted',100).complete,false);
  assert.equal(projectReply({mapping:{u:user,a:answer('partial',{status:'in_progress'})}},'submitted',100).complete,false);
});

test('internal reader refuses branches, tool content, non-text and excessive output', () => {
  assert.equal(projectReply({mapping:{u:user,a:answer(),b:answer('branch')}},'submitted',100),undefined);
  assert.equal(projectReply({mapping:{u:user,a:answer('hidden',{recipient:'browser'})}},'submitted',100),undefined);
  assert.equal(projectReply({mapping:{u:user,a:answer('',{content:{content_type:'image',parts:[{}]}})}},'submitted',100),undefined);
  assert.throws(()=>projectReply({mapping:{u:user,a:answer('long')}},'submitted',2),e=>e.code==='output_too_large');
  assert.equal(parseOptions().internalReader,false);
  assert.throws(()=>parseOptions({internalReader:'true'}));
});

test('real browser internal observation keeps the token in-page and classifies auth/rate failures', async () => {
  let status=200, reads=0, signedOut=false;
  const server=createServer((req,res)=>{
    if(req.url==='/api/auth/session'){
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify(signedOut ? {} : {user:{id:'fixture'},accessToken:'FIXTURE_SECRET_DO_NOT_EXPORT'}));return;
    }
    if(req.url==='/backend-api/conversation/example'){
      reads++;
      assert.equal(req.headers.authorization,'Bearer FIXTURE_SECRET_DO_NOT_EXPORT');
      res.statusCode=status;
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({mapping:{u:user,a:answer()}}));return;
    }
    res.setHeader('content-type','text/html');res.end('<html><body>fixture</body></html>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser=await chromium.launch({executablePath:await browserExecutable(),headless:true});
    const page=await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/c/example`);
    const result=await readInternalReply(page,'submitted',100);
    assert.deepEqual(result,{text:'answer',complete:true});
    assert.doesNotMatch(JSON.stringify(result),/SECRET|accessToken/);
    await assert.rejects(readInternalReply(page,'submitted',100,'wrong-identity'),e=>e.code==='account_changed');
    assert.equal(reads,1);
    status=401;
    await assert.rejects(readInternalReply(page,'submitted',100),e=>e.code==='sign_in_required');
    status=429;
    await assert.rejects(readInternalReply(page,'submitted',100),e=>e.code==='upstream_rate_limit');
    status=404;
    assert.equal(await readInternalReply(page,'submitted',100),undefined);
    assert.equal(reads,4);
    signedOut=true;
    await page.evaluate(()=>{
      const bootstrap=document.createElement('script');bootstrap.id='client-bootstrap';bootstrap.type='application/json';
      bootstrap.textContent=JSON.stringify({session:{user:{id:'stale'},accessToken:'STALE_TOKEN'}});document.body.append(bootstrap);
    });
    await assert.rejects(readInternalReply(page,'submitted',100),e=>e.code==='sign_in_required');
    assert.equal(reads,4,'explicit signed-out session must not consult backend with stale bootstrap');
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});

test('runtime reconciles a stalled DOM via internal reply, or returns to DOM without another send', async t => {
  for (const internalAvailable of [true,false]) {
    await t.test(internalAvailable ? 'internal completion' : 'DOM recovery after internal 404', async () => {
      let sends=0, reads=0;
      const server=createServer(async (req,res)=>{
        if(req.url==='/api/auth/session'){
          res.setHeader('content-type','application/json');
          res.end(JSON.stringify({user:{id:'fixture-account'},accessToken:'FIXTURE_ONLY'}));return;
        }
        if(req.url==='/sent'){sends++;res.end('ok');return;}
        if(req.url==='/backend-api/conversation/example'){
          reads++;
          res.statusCode=internalAvailable ? 200 : 404;
          res.setHeader('content-type','application/json');
          res.end(JSON.stringify({mapping:{u:{message:{id:'submitted',author:{role:'user'}}},a:answer('reconciled')}}));return;
        }
        res.setHeader('content-type','text/html');
        res.end(`<!doctype html><html><body>
          <div id="prompt-textarea" contenteditable="true"> </div>
          <button data-testid="send-button">Send</button><div id="messages"></div>
          <script>
          document.querySelector('button').onclick=()=>{
            fetch('/sent',{method:'POST'});history.replaceState({},'', '/c/example');
            document.querySelector('#messages').innerHTML='<article data-turn-id="submitted"><div data-message-author-role="user">question</div></article><button data-testid="stop-button">Stop</button>';
            if(${!internalAvailable})setTimeout(()=>{
              document.querySelector('[data-testid="stop-button"]').remove();
              document.querySelector('#messages').insertAdjacentHTML('beforeend','<article data-turn-id="reply"><div data-message-author-role="assistant"><div class="markdown"><p>DOM recovered</p></div></div><button data-testid="copy-turn-action-button">Copy</button></article>');
            },6500);
          };
          </script></body></html>`);
      });
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      const temp=await temporaryDirectory();
      const runtime=new BrowserRuntime(parseOptions({profilesDir:temp.path,executablePath:await browserExecutable(),browserMode:'managed',headless:true,internalReader:true,timeoutMs:10000,pollMs:50}),`http://127.0.0.1:${server.address().port}`);
      try {
        const {profileId}=await runtime.beginLogin();await runtime.waitLogin(profileId);
        const events=[];
        for await(const e of runtime.complete(profileId,{model:'web-current',prompt:'question',stream:true}))events.push(e);
        assert.equal(events.filter(e=>e.event==='delta').map(e=>e.text).join(''),internalAvailable ? 'reconciled' : 'DOM recovered');
        assert.equal(events.at(-1).event,'done');
        assert.equal(sends,1);
        assert.equal(reads,1);
      } finally {
        await runtime.close();await temp.close();
        server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
      }
    });
  }
});
