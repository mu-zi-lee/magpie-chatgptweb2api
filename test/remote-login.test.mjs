import test from 'node:test';
import assert from 'node:assert/strict';
import { createPluginHooks } from '../dist/plugin.js';

test('every remote auth flow shows the desktop link but saves only the profile association', async()=>{
  const profileId='12345678-1234-4234-8234-123456789abc';
  const url='https://login.example.invalid/vnc.html';
  const calls=[];
  const runtime={
    async call(method,params){
      calls.push({method,params});
      if(method.endsWith('Begin'))return {profileId};
      return {authenticated:true,ready:true,accountId:'fixture@example.invalid'};
    },
    async open(){throw new Error('No text requests in an auth test');},
    async close(){},
  };
  const hooks=createPluginHooks({remoteLoginUrl:url},runtime);
  for(const method of hooks.auth.methods){
    const inputs=method.label.includes('Cookie') ? {cookieFile:'/tmp/fixture-cookie.json'} : {profileId};
    const flow=await method.authorize(inputs);
    assert.ok(flow.instructions.includes(url),method.label);
    const saved=await flow.callback();
    assert.equal(saved.type,'success');assert.equal(saved.key,`browser:${profileId}`);
    assert.doesNotMatch(JSON.stringify(saved),/vnc\.html|fixture-cookie|accessToken/);
  }
  assert.deepEqual(calls.filter(c=>c.method.endsWith('Begin')).map(c=>c.method),['loginBegin','guestBegin','cookieBegin','loginBegin']);
});
