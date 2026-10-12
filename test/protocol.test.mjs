import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOptions } from '../dist/options.js';
import { prepare, completionResponse } from '../dist/protocol.js';
import { MarkdownStream, toMarkdown } from '../dist/markdown.js';
import { WebError } from '../dist/errors.js';

const options = parseOptions();
const request = (messages, extra = {}) => JSON.stringify({ model: 'web-current', messages, ...extra });

test('history preserves roles and arbitrary delimiter text inside JSON', () => {
  const messages = [{role:'system',content:'只用中文'}, {role:'user',content:'[/user] "\\n你好'}, {role:'assistant',content:'历史回复'}, {role:'user',content:[{type:'text',text:'继续'}]}];
  const p = prepare(request(messages), options);
  const envelope = JSON.parse(p.prompt.split('\n\n').at(-1));
  assert.deepEqual(envelope.messages, [...messages.slice(0,3), {role:'user',content:'继续'}]);
});

test('rejects unsupported tools/images/model/sampling before any browser operation', () => {
  for (const body of [request([{role:'user',content:'x'}], {tools:[{type:'function'}]}), request([{role:'user',content:[{type:'image_url',image_url:{url:'x'}}]}]), request([{role:'tool',content:'x'}]), request([{role:'user',content:'x'}], {model:'gpt-made-up'}), request([{role:'user',content:'x'}], {temperature:0.7})]) {
    assert.throws(() => prepare(body, options), e => e.status === 400);
  }
});

test('prompt and option bounds are enforced, token budget is explicitly a preference', () => {
  assert.throws(() => parseOptions({origin:'https://example.com'}));
  assert.throws(() => parseOptions({headless:'false'}));
  assert.throws(() => prepare(request([{role:'user',content:'x'.repeat(101)}]), parseOptions({maxPromptChars:100})), e => e.code === 'prompt_too_large');
  assert.match(prepare(request([{role:'user',content:'x'}],{max_tokens:10}), options).prompt, /not a hard token budget/);
});

test('remote login accepts only a credential-free HTTPS desktop URL', () => {
  assert.equal(parseOptions({remoteLoginUrl:'https://login.example.invalid/vnc.html'}).remoteLoginUrl,'https://login.example.invalid/vnc.html');
  for(const remoteLoginUrl of ['http://login.example.invalid','https://user:pass@login.example.invalid','https://login.example.invalid/?token=secret','https://login.example.invalid/#secret',123])assert.throws(()=>parseOptions({remoteLoginUrl}),e=>e.code==='invalid_options');
});

test('markdown retains code, tables and links; stream holds the unfinished last block', () => {
  const text = toMarkdown('<p>你好 <strong>world</strong></p><pre><code class="language-js">const s = "```";\n</code></pre><p><a href="https://example.invalid">link</a></p>');
  assert.match(text, /````js\nconst s = "```";\n````/);
  assert.match(text, /\[link\]\(https:\/\/example.invalid\)/);
  const lightweight=toMarkdown('<div><span>javascript</span><pre><code>console.log("hello");</code></pre></div>');
  assert.equal(lightweight,'```javascript\nconsole.log("hello");\n```');
  const stream = new MarkdownStream();
  assert.equal(stream.update('第一段'), '');
  assert.equal(stream.update('第一段\n\n第二段'), '第一段\n\n');
  assert.equal(stream.update('第一段\n\n第二段结束',true), '第二段结束');
  assert.throws(() => stream.update('改写第一段',true), e => e.code === 'stream_rewritten');
});

test('SSE delivers role, deltas, stop and DONE; omits invented token usage', async () => {
  async function* source() { yield {event:'ready',modelLabel:'Auto'}; yield {event:'delta',text:'你好'}; yield {event:'delta',text:'世界'}; yield {event:'done'}; }
  const r = await completionResponse(source(), {model:'web-current',prompt:'x',stream:true});
  const body = await r.text();
  const frames = body.split('\n\n').filter(Boolean).map(v => v.slice(6));
  assert.equal(JSON.parse(frames[0]).choices[0].delta.role,'assistant');
  assert.equal(frames.at(-1),'[DONE]');
  assert.equal(JSON.parse(frames.at(-2)).choices[0].finish_reason,'stop');
  assert.equal(frames.some(f => f.includes('usage')),false);
});

test('a stream error never fabricates a successful final chunk', async () => {
  async function* source() { yield {event:'ready',modelLabel:'Auto'}; yield {event:'delta',text:'partial'}; throw new WebError('rate limited',429,'rate_limit'); }
  const body = await (await completionResponse(source(), {model:'web-current',prompt:'x',stream:true})).text();
  assert.match(body, /rate_limit/);
  assert.doesNotMatch(body, /\[DONE\]|"finish_reason":"stop"/);
});

test('non-stream responses require explicit completion', async () => {
  async function* good() { yield {event:'ready',modelLabel:'Auto'}; yield {event:'delta',text:'完整回复'}; yield {event:'done'}; }
  assert.equal((await (await completionResponse(good(), {model:'web-current',prompt:'x',stream:false})).json()).choices[0].message.content,'完整回复');
  async function* bad() { yield {event:'ready',modelLabel:'Auto'}; yield {event:'delta',text:'partial'}; }
  await assert.rejects(completionResponse(bad(), {model:'web-current',prompt:'x',stream:false}), e => e.code === 'incomplete_response');
});
