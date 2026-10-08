import {_electron as electron} from 'playwright';
import electronPath from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const folder=fs.mkdtempSync(path.resolve('tests/.reports-'));
let app,page;const errors=[];
try {
 app=await electron.launch({executablePath:process.env.TIMELOG_TEST_EXECUTABLE||electronPath,args:[...(process.env.TIMELOG_TEST_NO_SANDBOX?['--no-sandbox','--disable-gpu']:[]),...(process.env.TIMELOG_TEST_EXECUTABLE?[]:['.'])],env:{...process.env,TIMELOG_TEST_DATA:folder},timeout:30000});
 page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.getByRole('button',{name:'Reports',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.bar-column').length===7);
 await page.getByRole('button',{name:'Month',exact:true}).click();
 const now=new Date(),days=new Date(now.getFullYear(),now.getMonth()+1,0).getDate();
 await page.waitForFunction(count=>document.querySelectorAll('.bar-column').length===count,days);
 await page.getByRole('button',{name:'Week',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.bar-column').length===7,null,{timeout:5000});
 assert.deepEqual(errors,[]);
 for(let i=0;i<20;i++){
  await page.getByRole('button',{name:'Month',exact:true}).click();await page.getByRole('button',{name:'Week',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.bar-column').length===7);
 }
 await page.getByRole('button',{name:'Previous period',exact:true}).click();await page.getByRole('button',{name:'Next period',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.bar-column').length===7);
 await page.getByRole('button',{name:'Day',exact:true}).click();await page.getByRole('heading',{name:'Time entries',exact:true}).waitFor();
 assert.deepEqual(errors,[]);console.log('Report regression passed: Month -> Week, 20 rapid cycles, period navigation, responsive Day screen, no renderer errors.');
}catch(error){console.error('Renderer errors:',errors);throw error;}finally{if(app)await app.close();}
