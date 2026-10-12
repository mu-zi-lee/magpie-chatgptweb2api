import { createServer } from 'node:http';
import { mkdtemp, rm, access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { chromium } from 'playwright';

export async function browserExecutable() {
  const candidates = [process.env.CHATGPTWEB_TEST_BROWSER, chromium.executablePath()].filter(Boolean);
  if (process.platform === 'darwin') {
    const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
    const dirs = await readdir(cache).catch(() => []);
    for (const dir of dirs.filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))) {
      candidates.push(join(cache, dir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'));
      candidates.push(join(cache, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
    }
  }
  for (const candidate of candidates) try { await access(candidate); return candidate; } catch {}
  throw new Error('A real Chromium executable is required. Run npm run browser:install or set CHATGPTWEB_TEST_BROWSER.');
}

export async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), 'chatgptweb-test-'));
  return { path, async close() { await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } };
}

export async function fixture() {
  const state = { mode: 'normal', renderer: 'legacy', authStatus: 200, bootstrap: false, authenticated: true, autoLogin: true, identity: 'fixture-account', submissions: [], stops: 0, requests: 0 };
  const server = createServer(async (req, res) => {
    state.requests++;
    if (req.url === '/api/auth/session') {
      if(state.authStatus!==200){res.statusCode=state.authStatus;res.end('Session endpoint unavailable');return;}
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(state.authenticated && req.headers.cookie?.includes('fixture=1') ? { user: { id: state.identity, email: 'fixture@example.invalid' } } : {})); return;
    }
    if (req.url === '/submitted') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      state.submissions.push(Buffer.concat(chunks).toString());
      res.end('ok'); return;
    }
    if (req.url === '/stopped') { state.stops++; res.end('ok'); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if(state.mode==='verification'){res.statusCode=403;res.end('<!doctype html><html><head><title>Just a moment...</title></head><body>Verification required</body></html>');return;}
    if (state.autoLogin) res.setHeader('set-cookie', 'fixture=1; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400');
    const session=state.authenticated&&req.headers.cookie?.includes('fixture=1') ? {user:{id:state.identity,email:'fixture@example.invalid'},accessToken:'FIXTURE_ONLY_DO_NOT_TRANSFER'} : null;
    res.end(`<!doctype html><html><head><meta charset="utf-8">${state.bootstrap ? '<script id="client-bootstrap" type="application/json">'+JSON.stringify({session})+'</script>' : ''}</head><body>
      <button data-testid="model-switcher-dropdown-button">Auto</button>
      <div id="menu" hidden role="menu"><button role="menuitem">Auto</button><button role="menuitem">Thinking</button></div>
      <div id="messages"><article data-turn-id="old-user"><div data-message-author-role="user">old question</div></article>
      <article data-turn-id="old-assistant"><div data-message-author-role="assistant"><div class="markdown"><p>OLD ANSWER MUST NEVER BE RETURNED</p></div></div><button data-testid="copy-turn-action-button">Copy</button></article></div>
      <div id="prompt-textarea" contenteditable="true" style="min-height:40px;border:1px solid"></div>
      <button data-testid="send-button">Send</button><div id="controls"></div>
      <script>
        const mode = ${JSON.stringify(state.mode)};
        const grouped = ${JSON.stringify(state.renderer)} === 'group';
        const mobile = ${JSON.stringify(state.renderer)} === 'mobile';
        const messages = document.querySelector('#messages');
        if (grouped) messages.innerHTML='<article data-turn-key="old"><div data-user-message-bubble>old question</div><div data-content-search-unit-key="old-answer"><span data-conversation-role="assistant"></span><div data-markdown-text-style="assistant-message"><p>OLD ANSWER MUST NEVER BE RETURNED</p></div></div><div class="turn-action-controls"><button>Copy</button></div></article>';
        if (mobile) {
          messages.innerHTML='<ol data-conversation-transcript><li id="old-user" data-message-role="user">old question</li><li id="old-assistant" data-message-role="assistant" data-message-complete><div data-assistant-markdown><p>OLD ANSWER MUST NEVER BE RETURNED</p></div></li></ol>';
          document.querySelector('#prompt-textarea').outerHTML='<textarea data-mobile-composer-prompt id="mobile-composer-prompt"></textarea>';
        }
        const composer = document.querySelector(mobile ? '#mobile-composer-prompt' : '#prompt-textarea');
        const send = document.querySelector('[data-testid="send-button"]');
        if (mobile) {
          send.removeAttribute('data-testid');send.setAttribute('data-composer-submit','');send.setAttribute('aria-disabled','true');
          send.innerHTML='<span data-composer-stop-icon hidden>Stop</span><span>Send</span>';
          composer.oninput=()=>send.setAttribute('aria-disabled',composer.value?'false':'true');
        }
        let stopCurrent;
        const picker = document.querySelector('[data-testid="model-switcher-dropdown-button"]');
        const menu = document.querySelector('#menu');
        picker.onclick = () => menu.hidden = !menu.hidden;
        for (const item of menu.children) item.onclick = () => { picker.textContent = item.textContent; menu.hidden = true; };
        send.onclick = async () => {
          if (mobile && !send.querySelector('[data-composer-stop-icon]').hidden) { stopCurrent?.(); return; }
          const prompt = mobile ? composer.value : composer.textContent;
          send.disabled = true;
          fetch('/submitted', {method:'POST', body:prompt});
          const user = document.createElement(mobile ? 'li' : 'article');
          if (mobile) { user.id='new-user';user.dataset.messageRole='user'; } else if (grouped) user.dataset.turnKey = 'new'; else user.dataset.turnId = 'new-user';
          const body = document.createElement('div');
          if (grouped || mobile) body.setAttribute('data-user-message-bubble',''); else body.dataset.messageAuthorRole = 'user';
          body.textContent = prompt;
          const transcript=mobile ? messages.querySelector('[data-conversation-transcript]') : messages;
          user.append(body); transcript.append(user); if (mobile) composer.value=''; else composer.textContent = '';
          if (grouped) { const copy=document.createElement('div'); copy.className='turn-action-controls'; copy.innerHTML='<button>Copy user</button>'; user.append(copy); }
          // Remount historical content after Send; its logical identity is unchanged.
          const old = document.querySelector(mobile ? '#old-assistant' : grouped ? '[data-turn-key="old"]' : '[data-turn-id="old-assistant"]'); old.replaceWith(old.cloneNode(true));
          if (mode === 'rate-limit') { setTimeout(() => { const a = document.createElement('div'); a.setAttribute('role','alert'); a.textContent='You have hit the limit reached'; document.body.append(a); }, 100); return; }
          const assistant = document.createElement(mobile ? 'li' : 'article');
          if (mobile) {assistant.id='new-assistant';assistant.dataset.messageRole='assistant';} else assistant.dataset.turnId='new-assistant';
          assistant.innerHTML=mobile ? '<h4 data-message-attribution>ChatGPT 说：</h4><div data-assistant-markdown></div>' : grouped ? '<div><span data-chatgpt-agent-turn-start></span><div data-markdown-text-style="assistant-message" data-markdown-text-tone="tertiary">THINKING MUST NEVER BE RETURNED</div></div><div data-content-search-unit-key="answer"><span data-conversation-role="assistant"></span><div data-markdown-text-style="assistant-message"></div></div>' : '<div data-message-author-role="assistant"><div class="markdown"></div></div>';
          const md = assistant.querySelector(mobile ? '[data-assistant-markdown]' : grouped ? '[data-content-search-unit-key="answer"] [data-markdown-text-style]' : '.markdown');
          const mount = () => (grouped ? user : transcript).append(assistant);
          let timers = [];
          const stop = () => { for (const t of timers) clearTimeout(t); fetch('/stopped',{method:'POST'}); document.querySelector('[data-testid="stop-button"]')?.remove(); send.disabled=false; if(mobile){send.querySelector('[data-composer-stop-icon]').hidden=true;send.setAttribute('aria-disabled','true');} };
          stopCurrent=stop;
          const start = () => { if(mobile){send.disabled=false;send.setAttribute('aria-disabled','false');send.querySelector('[data-composer-stop-icon]').hidden=false;return;} const b=document.createElement('button'); b.dataset.testid='stop-button'; b.textContent='Stop'; b.onclick=stop; document.querySelector('#controls').append(b); };
          const finish = () => { document.querySelector('[data-testid="stop-button"]')?.remove(); send.disabled=false; if(mobile){send.querySelector('[data-composer-stop-icon]').hidden=true;send.setAttribute('aria-disabled','true');assistant.setAttribute('data-message-complete','');return;} const c=document.createElement('button'); c.dataset.testid='copy-turn-action-button'; c.textContent='Copy'; assistant.append(c); };
          if (mode === 'delayed-start') {
            mount(); md.innerHTML='<p>暂时显示的片段</p>';
            timers.push(setTimeout(start,700));
            timers.push(setTimeout(() => { md.innerHTML='<p>最终完整回复</p>'; finish(); },1100)); return;
          }
          if (mobile) { assistant.id='pending-provisional';mount(); }
          timers.push(setTimeout(() => { if(mobile)assistant.id='new-assistant';start(); mount(); md.innerHTML='<p>第一段：中文流式。</p>'; },80));
          if (mode === 'timeout') return;
          timers.push(setTimeout(() => { md.innerHTML='<p>第一段：中文流式。</p><pre><code class="language-js">const x = 1;\\n</code></pre>'; },220));
          timers.push(setTimeout(() => {
            md.innerHTML=(mode === 'rewrite' ? '<p>第一页被改写。</p>' : '<p>第一段：中文流式。</p>') + '<pre><code class="language-js">const x = 1;\\n</code></pre><p><strong>完成</strong>，<a href="https://example.invalid/">链接</a>。</p>'; finish();
          },480));
        };
      </script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { state, url: `http://127.0.0.1:${server.address().port}`, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
