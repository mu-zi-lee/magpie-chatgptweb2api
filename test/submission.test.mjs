import test from 'node:test';
import assert from 'node:assert/strict';
import { Submission } from '../dist/submission.js';

test('fallback send is allowed only before any submission attempt', () => {
  const s=new Submission();
  assert.equal(s.canFallbackSend,true);
  s.attempt();
  assert.equal(s.state,'attempted');
  assert.equal(s.canFallbackSend,false);
  assert.throws(()=>s.attempt(),e=>e.code==='duplicate_submission_prevented');
  s.confirm();assert.equal(s.canFallbackSend,false);
  s.complete();assert.equal(s.state,'completed');assert.equal(s.canFallbackSend,false);
});

test('submission transitions cannot fabricate confirmation or completion', () => {
  assert.throws(()=>new Submission().confirm(),e=>e.code==='invalid_submission_state');
  assert.throws(()=>new Submission().complete(),e=>e.code==='invalid_submission_state');
  const s=new Submission();s.attempt();
  assert.throws(()=>s.complete(),e=>e.code==='invalid_submission_state');
});
