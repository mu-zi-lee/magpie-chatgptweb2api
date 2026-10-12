import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,utimes,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {lockProfile} from '../dist/profile-lock.js';
import {temporaryDirectory} from './helpers.mjs';

test('profile lease rejects concurrent operations and permits use after release',async t=>{
  const temp=await temporaryDirectory();t.after(()=>temp.close());
  const directory=join(temp.path,'profile');await mkdir(directory);
  const first=await lockProfile(directory);t.after(()=>first.release());
  await assert.rejects(lockProfile(directory),e=>e.code==='account_busy');
  await first.release();const second=await lockProfile(directory);
  await second.release();await second.release();
});

test('expired crash lock can be recovered and a symlink cannot be used as lock',async t=>{
  const temp=await temporaryDirectory();t.after(()=>temp.close());
  const directory=join(temp.path,'profile');await mkdir(directory);
  const lockPath=directory+'.operation.lock';await mkdir(lockPath);
  const expired=new Date(Date.now()-60000);await utimes(lockPath,expired,expired);
  const recovered=await lockProfile(directory);await recovered.release();
  const unrelated=join(temp.path,'unrelated');await mkdir(unrelated);
  await symlink(unrelated,lockPath);
  await assert.rejects(lockProfile(directory),e=>e.code==='profile_lock_invalid');
});
