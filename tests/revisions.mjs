import {_electron as electron} from 'playwright';
import electronPath from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const folder=fs.mkdtempSync(path.resolve('tests/.revisions-'));
let app;
try {
 app=await electron.launch({executablePath:electronPath,args:['--no-sandbox','--disable-gpu','.'],env:{...process.env,TIMELOG_TEST_DATA:folder},timeout:30000});
 const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.getByRole('button',{name:'Day',exact:true}).waitFor();
 async function api(group,method,...args){const r=await page.evaluate(({group,method,args})=>window.api[group][method](...args),{group,method,args});assert.equal(r.ok,true,r.error);return r.value;}
 await api('settings','save',{timeFormat:'12h',workMinutes:1,shortBreak:1,longBreak:1,cycles:4});
 await page.getByRole('button',{name:'Add entry',exact:true}).click();
 const start=page.getByLabel('Start time hour',{exact:true}),old=await start.inputValue();
 await start.fill('abc');assert.equal(await start.inputValue(),old);
 await start.fill('');assert.equal(await start.inputValue(),old);
 await start.fill('99');assert.equal(await start.inputValue(),old);
 await page.getByLabel('Start time minute',{exact:true}).fill('60');assert.notEqual(await page.getByLabel('Start time minute',{exact:true}).inputValue(),'60');
 const date=page.getByLabel('Start date',{exact:true}),originalDate=await date.inputValue();
 await date.fill('');assert.equal(await date.inputValue(),originalDate);
 await date.fill('23432-10-08');assert.equal(await date.inputValue(),originalDate);
 await page.getByLabel('Duration hour',{exact:true}).fill('99');assert.notEqual(await page.getByLabel('Duration hour',{exact:true}).inputValue(),'99');
 await page.keyboard.press('Escape');
 const bounds=await page.locator('.timer-pill').boundingBox(),footer=await page.locator('.timer-footer').boundingBox();assert.ok(bounds.width>=footer.width-65,'Timer bar must span footer width with padding');
 const now=new Date(),day=new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();
 for(const [hour,note] of [[8,'Older UI check'],[10,'Newest UI check']])await api('entries','save',{projectId:null,startAt:day+hour*3600000,endAt:day+(hour+1)*3600000,note,tagIds:[],billable:false});
 assert.match(await page.locator('.entry-card').first().innerText(),/Newest UI check/);
 for(const e of (await api('state','get')).entries)await api('entries','delete',e.id);
 await api('pomodoro','start',{projectId:null,tagIds:[],note:'UI check Pomodoro'});
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().includes('widget=1')).hide());
 async function finish(){const p=(await api('state','get')).pomo;await app.evaluate((_,now)=>{globalThis.realNow??=Date.now;Date.now=()=>now;},p.deadline+100);await page.waitForTimeout(1300);}
 await finish();let state=await api('state','get');assert.equal(state.pomo.phase,'short-break');assert.equal(state.pomo.awaiting,true);assert.equal(state.pomo.alarming,true);assert.equal(state.pomo.paused,true);assert.equal(state.entries.filter(e=>e.endAt===null).length,0);
 const alarm=app.windows().find(w=>w.url().includes('alarm=1'));assert.ok(alarm,'Phase completion must create an independent alert window');
 await alarm.getByRole('button',{name:'Start break',exact:true}).waitFor();await alarm.waitForTimeout(500);
 const sound=await alarm.locator('audio').evaluate(el=>({loop:el.loop,paused:el.paused,loaded:el.readyState,time:el.currentTime}));assert.equal(sound.loop,true);assert.equal(sound.paused,false);assert.ok(sound.loaded>=2);assert.ok(sound.time>0);
 await api('pomodoro','dismiss');state=await api('state','get');assert.equal(state.pomo.awaiting,true);assert.equal(state.pomo.alarming,false);assert.equal(state.pomo.paused,true);
 await api('pomodoro','resume');state=await api('state','get');assert.equal(state.pomo.awaiting,false);assert.equal(state.pomo.phase,'short-break');assert.equal(state.entries.filter(e=>e.endAt===null).length,0);
 await finish();state=await api('state','get');assert.equal(state.pomo.phase,'work');assert.equal(state.pomo.awaiting,true);assert.equal(state.entries.filter(e=>e.endAt===null).length,0);
 await api('pomodoro','resume');state=await api('state','get');assert.equal(state.pomo.awaiting,false);assert.equal(state.entries.filter(e=>e.endAt===null).length,1);
 await api('pomodoro','stop');await app.evaluate(()=>{Date.now=globalThis.realNow;});assert.deepEqual(errors,[]);
 console.log('Revisions passed: protected dates/time, full-width timer bar, newest entries first, independent Pomodoro alert, looping audio playback, dismiss waits, explicit phase start, no automatic work entry.');
}finally{await app?.close();}
