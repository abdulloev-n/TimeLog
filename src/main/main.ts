import {app,BrowserWindow,ipcMain,Tray,Menu,nativeImage,globalShortcut,dialog,shell,Notification,nativeTheme,powerMonitor,session,screen} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {APP_NAME,type Pomo} from '../shared/types.ts';
import {Store,unwrap,emptyPomo} from './store.ts';
import * as D from '../domain/index.ts';

app.setName(APP_NAME);
Menu.setApplicationMenu(null);
app.setAppUserModelId('local.timelog.desktop');
if(process.env.TIMELOG_TEST_DATA)app.setPath('userData',process.env.TIMELOG_TEST_DATA);else app.setPath('userData',path.join(app.getPath('appData'),APP_NAME));
const lock=app.requestSingleInstanceLock();if(!lock)app.quit();
let win:BrowserWindow|null=null,widget:BrowserWindow|null=null,tray:Tray|null=null,alarmWindow:BrowserWindow|null=null,store:Store,quitting=false;
let timerIcon=false,seconds=0;
const dev=process.env.TIMELOG_DEV_URL;
function page(w:BrowserWindow,widgetMode=false){if(dev)w.loadURL(dev+(widgetMode?'?widget=1':''));else w.loadFile(path.join(__dirname,'../renderer/index.html'),widgetMode?{query:{widget:'1'}}:{});}
function makeWindow(widgetMode=false){const w=new BrowserWindow({width:widgetMode?340:1280,height:widgetMode?270:850,minWidth:widgetMode?300:820,minHeight:widgetMode?250:600,title:widgetMode?APP_NAME+' · Pomodoro':APP_NAME,icon:path.join(__dirname,'assets','icon.ico'),show:false,alwaysOnTop:widgetMode,autoHideMenuBar:true,backgroundColor:nativeTheme.shouldUseDarkColors?'#191919':'#ffffff',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,offscreen:!!process.env.TIMELOG_TEST_DATA}});
 w.webContents.setWindowOpenHandler(()=>({action:'deny'}));w.webContents.on('will-navigate',(event)=>event.preventDefault());w.once('ready-to-show',()=>{if(!process.env.TIMELOG_TEST_DATA)w.show();});page(w,widgetMode);
 if(widgetMode)w.on('closed',()=>widget=null);else {w.on('close',e=>{if(!quitting){e.preventDefault();w.hide();}});w.on('closed',()=>win=null);}return w;}
function showMain(){if(!win)win=makeWindow();win.show();win.focus();}
function showWidget(){if(!widget)widget=makeWindow(true);else{widget.show();widget.focus();}}
function closeAlarm(){const w=alarmWindow;alarmWindow=null;if(w&&!w.isDestroyed())w.destroy();}
function pomoDismiss(){const p=store.pomo();if(p.awaiting)putPomo({...p,alarming:false});closeAlarm();}
function showAlarm(){
 if(alarmWindow&&!alarmWindow.isDestroyed()){alarmWindow.show();alarmWindow.focus();return;}
 const area=screen.getPrimaryDisplay().workArea;
 const w=new BrowserWindow({width:420,height:290,x:area.x+area.width-440,y:area.y+area.height-310,resizable:false,minimizable:false,maximizable:false,alwaysOnTop:true,show:false,title:APP_NAME+' · Phase complete',icon:path.join(__dirname,'assets','icon.ico'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required',offscreen:!!process.env.TIMELOG_TEST_DATA}});
 alarmWindow=w;
 w.webContents.setWindowOpenHandler(()=>({action:'deny'}));w.webContents.on('will-navigate',e=>e.preventDefault());
 w.once('ready-to-show',()=>{if(!process.env.TIMELOG_TEST_DATA){w.show();w.focus();w.flashFrame(true);}});
 w.on('close',e=>{if(!quitting){e.preventDefault();safe(pomoDismiss);}});w.on('closed',()=>{if(alarmWindow===w)alarmWindow=null;});
 if(dev)w.loadURL(dev+'?alarm=1');else w.loadFile(path.join(__dirname,'../renderer/index.html'),{query:{alarm:'1'}});
}
const notifications=new Set<Notification>();
function notify(title:string,body:string){
 store.notice=body;
 if(process.platform==='win32'&&tray){
  try{tray.displayBalloon({title,content:body,icon:path.join(__dirname,'assets','icon.ico'),iconType:'custom',respectQuietTime:true});}catch{ /* The phase message remains visible in TimeLog. */ }
  return;
 }
 if(!Notification.isSupported())return;
 const notification=new Notification({title,body,icon:path.join(__dirname,'assets','icon.ico')});
 notifications.add(notification);
 notification.once('close',()=>notifications.delete(notification));
 notification.once('failed',()=>notifications.delete(notification));
 notification.once('click',()=>{notifications.delete(notification);showMain();});
 notification.show();
}
function icon(active:boolean){return nativeImage.createFromPath(path.join(__dirname,'assets',active?'tray-running.png':'tray-stopped.png'));}
function elapsed(ms:number){ms=Math.max(0,ms);const h=Math.floor(ms/3600000),m=Math.floor(ms/60000)%60,s=Math.floor(ms/1000)%60;return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;}
function safe(fn:()=>void){try{fn();broadcast();}catch(e){notify('TimeLog',message(e));broadcast();}}
function message(e:unknown){return e instanceof Error?e.message:String(e);}
function toggleTimer(){if(store.pomo().active){pomoStop();return;}const running=store.entries().find(e=>e.endAt===null);if(running)store.stopTimer();else store.startTimer({projectId:null});}
function updateTray(){if(!tray)return;const running=store.entries().find(e=>e.endAt===null),p=store.pomo();const active=!!running;if(active!==timerIcon){tray.setImage(icon(active));timerIcon=active;}tray.setToolTip(running?`${APP_NAME} · ${elapsed(Date.now()-running.startAt)} · ${running.note||store.project(running.projectId)?.name||'No project'}`:APP_NAME);
 tray.setContextMenu(Menu.buildFromTemplate([{label:running?'Stop timer':'Start timer',click:()=>safe(toggleTimer)},{label:running?`${elapsed(Date.now()-running.startAt)} · ${running.note||'Current entry'}`:'No timer running',enabled:false},{type:'separator'},{label:p.active?'Stop Pomodoro':'Start Pomodoro',click:()=>safe(()=>p.active?pomoStop():pomoStart({projectId:null,tagIds:[],note:''}))},{label:'Pomodoro widget',click:showWidget},{label:'Open TimeLog',click:showMain},{type:'separator'},{label:'Quit',click:()=>{quitting=true;app.quit();}}]));}
function broadcast(){const snap=store.snapshot();for(const w of [win,widget,alarmWindow])if(w&&!w.isDestroyed())w.webContents.send('state',snap);updateTray();}
function registerShortcut(){globalShortcut.unregisterAll();const shortcut=store.settings().shortcut;store.shortcutError=null;if(!shortcut)return;try{if(!globalShortcut.register(shortcut,()=>safe(toggleTimer)))store.shortcutError=`The shortcut ${shortcut} is already in use. Choose another shortcut in Settings.`;}catch{store.shortcutError='Windows could not register this shortcut. Use a combination such as Control+Alt+T.';}}
function putPomo(p:Pomo){store.transaction(()=>store.putPomo(p));}
function phaseDuration(p:Pomo){const s=store.settings();return (p.phase==='work'?s.workMinutes:p.phase==='long-break'?s.longBreak:s.shortBreak)*60000;}
function beginPhase(p:Pomo){const duration=phaseDuration(p);let entryId:null|string=null;if(p.phase==='work')entryId=store.startTimer({projectId:p.projectId,tagIds:p.tagIds,note:p.note}).id;putPomo({...p,paused:false,awaiting:false,alarming:false,entryId,remaining:duration,deadline:Date.now()+duration});}
function pomoStart(i:any){if(store.pomo().active)throw new Error('Pomodoro is already running.');if(store.entries().some(e=>e.endAt===null))throw new Error('Stop the current timer before starting Pomodoro.');const p={...emptyPomo,active:true,projectId:i.projectId??null,tagIds:store.checkTags(i.tagIds??[]),note:unwrap(D.normalizeNote(i.note))};beginPhase(p);showWidget();}
function endPomoWork(p:Pomo,stopAt?:number){if(p.entryId){const e=store.entries().find(e=>e.id===p.entryId&&e.endAt===null);if(e)store.stopTimer(stopAt);}}
function pomoPause(){const p=store.pomo();if(!p.active||p.paused)return;endPomoWork(p);putPomo({...p,paused:true,entryId:null,remaining:Math.max(0,p.deadline-Date.now())});}
function pomoResume(){const p=store.pomo();if(!p.active||!p.paused)return;if(p.awaiting){pomoDismiss();beginPhase({...p,alarming:false});return;}if(p.remaining<=0){pomoNext();return;}let id=null;if(p.phase==='work')id=store.startTimer({projectId:p.projectId,tagIds:p.tagIds,note:p.note}).id;putPomo({...p,paused:false,entryId:id,deadline:Date.now()+p.remaining});}
function pomoStop(){const p=store.pomo();endPomoWork(p);putPomo({...emptyPomo});closeAlarm();}
function pomoNext(natural=false){const p=store.pomo();if(!p.active)return;if(p.awaiting){pomoResume();return;}endPomoWork(p,natural&&p.phase==='work'?Math.min(p.deadline,Date.now()):undefined);const next:Pomo={...p,entryId:null};if(p.phase==='work')next.phase=p.cycle%store.settings().cycles===0?'long-break':'short-break';else{next.phase='work';next.cycle=p.cycle+1;}
 if(natural){putPomo({...next,paused:true,awaiting:true,alarming:true,remaining:phaseDuration(next),deadline:0});store.notice=p.phase==='work'?'Work phase complete. Start your break when ready.':'Break complete. Start work when ready.';showAlarm();return;}
 try{beginPhase(next);}catch(e){putPomo({...next,paused:true,remaining:phaseDuration(next),deadline:0});throw e;}}
let tickBusy=false;
function tick(){if(tickBusy)return;tickBusy=true;try{
 const entries=store.entries(),running=entries.find(e=>e.endAt===null);if(running){const now=Date.now(),p=store.pomo();const next=entries.filter(e=>e.id!==running.id&&e.startAt>running.startAt).sort((a,b)=>a.startAt-b.startAt)[0];const boundary=Math.min(running.startAt+86400000,next?.startAt??Infinity);const phaseEndsFirst=p.active&&!p.paused&&p.entryId===running.id&&p.deadline<=boundary;if(now>=boundary&&!phaseEndsFirst){store.stopTimer(boundary);notify('Timer stopped',next&&next.startAt===boundary?'Your timer reached the start of another saved entry.':'Your entry reached the 24-hour limit.');if(p.entryId===running.id)putPomo({...p,paused:true,entryId:null,remaining:Math.max(0,p.deadline-boundary)});}}
 const p=store.pomo();if(p.active&&!p.paused&&Date.now()>=p.deadline)pomoNext(true);
 }catch(e){const msg=message(e);if(store.notice!==msg)notify('TimeLog needs your attention',msg);}finally{tickBusy=false;seconds++;broadcast();}}
function escapeHtml(s:unknown){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));}
function invoiceHtml(row:D.InvoiceRow){const snap=unwrap(D.readInvoiceSnapshot(row)),e=escapeHtml;return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{font:14px Arial;color:#252525;margin:50px}h1{font-size:32px}header{display:flex;justify-content:space-between}section{margin:30px 0;white-space:pre-line}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:14px 8px;border-bottom:1px solid #ddd}td:nth-child(n+2),th:nth-child(n+2){text-align:right}.total{text-align:right;font-size:20px;margin:30px 0}footer{white-space:pre-line;color:#555;margin-top:45px}</style></head><body><header><div><h1>Invoice</h1><b>${e(row.number)}</b><p>Issued ${e(new Date(row.issued_at).toLocaleDateString())}</p></div><section>${e(snap.sender.name)}<br>${e(snap.sender.address)}<br>${e(snap.sender.email)}</section></header><section><b>Bill to</b><br>${e(snap.client.name)}<br>${e(snap.client.address)}<br>${e(snap.client.email)}</section><p>Period: ${e(new Date(row.period_start).toLocaleDateString())} – ${e(new Date(row.period_end-1).toLocaleDateString())}</p><table><thead><tr><th>Project</th><th>Hours</th><th>Hourly rate</th><th>Amount</th></tr></thead><tbody>${snap.lines.map(l=>`<tr><td>${e(l.projectName)}</td><td>${e(l.hours)}</td><td>${e(D.formatMoney(l.hourlyRateMinor,l.currency))}</td><td>${e(D.formatMoney(l.amountMinor,l.currency))}</td></tr>`).join('')}</tbody></table><p class="total"><b>Total ${e(D.formatMoney(row.total_minor,row.currency))} ${e(row.currency)}</b></p><footer>${e(snap.sender.paymentDetails)}</footer></body></html>`;}
async function savePdf(id:string){const row=store.invoices().find(r=>r.id===id);if(!row)throw new Error('Invoice not found.');const chosen=await dialog.showSaveDialog({title:'Save invoice PDF',defaultPath:row.number.replace(/[^a-z0-9._-]/gi,'_')+'.pdf',filters:[{name:'PDF',extensions:['pdf']}]});if(chosen.canceled||!chosen.filePath)return false;
 const hidden=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});try{await hidden.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(invoiceHtml(row)));const pdf=await hidden.webContents.printToPDF({printBackground:true,pageSize:'A4'});fs.writeFileSync(chosen.filePath,pdf);return true;}finally{hidden.destroy();}}
async function importDatabase(){const confirm=await dialog.showMessageBox({type:'warning',buttons:['Cancel','Import backup'],defaultId:0,cancelId:0,message:'Replace all current TimeLog data?',detail:'TimeLog will keep a timestamped copy of your current database. Import replaces entries, projects, settings and invoices.'});if(confirm.response!==1)return false;const picked=await dialog.showOpenDialog({properties:['openFile'],filters:[{name:'TimeLog database',extensions:['sqlite','db']}]});if(picked.canceled)return false;const file=picked.filePaths[0];if(fs.statSync(file).size>100*1024*1024)throw new Error('Backup is larger than 100 MB.');const candidate=store.load(fs.readFileSync(file));const old=store.db,previousSequence=store.invoiceSequence();try{store.db=candidate;const versions=store.rows('SELECT version FROM schema_migrations');if(versions.length!==2||versions.some(v=>![1,2].includes(v.version)))throw new Error('Unsupported TimeLog backup version.');store.validate();}catch(e){store.db=old;candidate.close();throw e;}store.db=old;store.flush();fs.copyFileSync(store.file,path.join(store.folder,`backup-before-import-${Date.now()}.sqlite`));store.db=candidate;try{store.transaction(()=>store.keepInvoiceSequence(previousSequence));old.close();}catch(e){store.db=old;candidate.close();throw e;}registerShortcut();store.notice='Backup imported. Your previous data is in the data folder.';return true;}
function requireInput(x:any){if(!x||typeof x!=='object'||Array.isArray(x))throw new Error('Invalid request.');return x;}
const actions:Record<string,(...args:any[])=>any>={
 'state.get':()=>store.snapshot(),
 'entries.save':i=>store.saveEntry(requireInput(i)),
 'entries.delete':id=>{const e=store.getEntry(id);if(store.pomo().entryId===e.id)throw new Error('Stop Pomodoro before deleting its current entry.');store.transaction(()=>store.write('DELETE FROM time_entries WHERE id=?',[id]));},
 'timer.start':i=>{if(store.pomo().active)throw new Error('Stop Pomodoro before starting another timer.');return store.startTimer(requireInput(i));},
 'timer.stop':()=>{tick();return store.pomo().active?pomoStop():store.stopTimer();},
 'projects.save':i=>store.saveProject(requireInput(i)),
 'projects.remove':(id,archive=false)=>{const p=store.project(id)!;const count=store.entries().filter(e=>e.projectId===id).length;const decision=unwrap(D.decideProjectRemoval({project:p,entryReferenceCount:count}));store.transaction(()=>decision.action==='delete-after-confirmation'&&!archive?store.write('DELETE FROM projects WHERE id=?',[id]):store.write('UPDATE projects SET archived=1 WHERE id=?',[id]));},
 'projects.restore':id=>{store.project(id);store.transaction(()=>store.write('UPDATE projects SET archived=0 WHERE id=?',[id]));},
 'clients.save':i=>store.saveClient(requireInput(i)),
 'clients.remove':(id,archiveProjects=false)=>{unwrap(D.validateId(id));const c=store.clients().find(c=>c.id===id);if(!c)throw new Error('Client not found.');const decision=unwrap(D.decideClientRemoval({client:c,projects:store.projects(),invoiceReferenceCount:store.invoices().filter(r=>r.client_id===id).length}));store.transaction(()=>{if(decision.action==='delete-after-confirmation')store.write('DELETE FROM clients WHERE id=?',[id]);else{store.write('UPDATE clients SET archived=1 WHERE id=?',[id]);if(archiveProjects)store.write('UPDATE projects SET archived=1 WHERE client_id=?',[id]);}});},
 'clients.restore':id=>{unwrap(D.validateId(id));store.transaction(()=>store.write('UPDATE clients SET archived=0 WHERE id=?',[id]));},
 'tags.save':i=>store.saveTag(requireInput(i)), 'tags.delete':id=>{unwrap(D.validateId(id));store.transaction(()=>{store.write('DELETE FROM tags WHERE id=?',[id]);const p=store.pomo();store.putPomo({...p,tagIds:p.tagIds.filter(t=>t!==id)});});},
 'reports.get':(period,days)=>store.report(period,days),
 'invoice.preview':i=>store.invoiceDraft(requireInput(i)), 'invoice.create':i=>store.createInvoice(requireInput(i)), 'invoice.savePdf':savePdf,
 'pomodoro.start':i=>pomoStart(requireInput(i)), 'pomodoro.pause':pomoPause, 'pomodoro.resume':pomoResume, 'pomodoro.dismiss':pomoDismiss, 'pomodoro.skip':()=>pomoNext(), 'pomodoro.stop':pomoStop, 'pomodoro.show':showWidget,
 'settings.testNotification':()=>notify(APP_NAME,'Test notification. Pomodoro will notify you when a phase ends.'),
 'settings.save':i=>{store.saveSettings(requireInput(i));registerShortcut();}, 'settings.clearNotice':()=>{store.notice=null;store.shortcutError=null;},
 'data.open':async()=>{const error=await shell.openPath(store.folder);if(error)throw new Error(error);},
 'data.export':async()=>{const picked=await dialog.showSaveDialog({defaultPath:`TimeLog-backup-${new Date().toISOString().slice(0,10)}.sqlite`,filters:[{name:'SQLite database',extensions:['sqlite']}]});if(picked.canceled||!picked.filePath)return false;store.flush();if(path.resolve(picked.filePath)===path.resolve(store.file))throw new Error('Choose a different destination from the active database.');fs.copyFileSync(store.file,picked.filePath);return true;},
 'data.import':importDatabase
};
app.on('second-instance',()=>showMain());
app.on('window-all-closed',()=>{});
app.on('before-quit',()=>{quitting=true;try{store?.flush();}catch(e){dialog.showErrorBox('TimeLog could not save',message(e));}});
app.on('will-quit',()=>globalShortcut.unregisterAll());
if(lock)app.whenReady().then(async()=>{
 try{
  session.defaultSession.webRequest.onBeforeRequest((details,callback)=>{const url=details.url;const allowed=url.startsWith('file:')||url.startsWith('data:')||(!!dev&&(url.startsWith(dev+'/')||url===dev||url.startsWith('ws://127.0.0.1:5173/')));callback({cancel:!allowed});});
  store=new Store(app.getPath('userData'));await store.open(app.isPackaged?path.join(process.resourcesPath,'sql-wasm.wasm'):path.join(__dirname,'sql-wasm.wasm'));
  ipcMain.handle('timelog',async(event,action:string,...args:any[])=>{try{const valid=[win,widget,alarmWindow].some(w=>w&&!w.isDestroyed()&&event.sender===w.webContents&&event.senderFrame===w.webContents.mainFrame);if(!valid||!Object.hasOwn(actions,action))throw new Error('Request denied.');const value=await actions[action](...args);if(action!=='state.get'&&action!=='reports.get'&&action!=='invoice.preview')broadcast();return {ok:true,value};}catch(e){return {ok:false,error:message(e)};}});
  tray=new Tray(icon(false));tray.on('double-click',showMain);tray.on('balloon-click',showMain);registerShortcut();win=makeWindow();
  const rec=unwrap(D.recoverRunningTimer(store.entries(),Date.now()));if(rec.kind==='clock-changed')store.notice='Your system clock moved before the timer start. Edit its start time to continue.';
  tick();if(store.pomo().alarming)showAlarm();setInterval(tick,1000);powerMonitor.on('resume',tick);nativeTheme.on('updated',broadcast);
 }catch(e){dialog.showErrorBox('TimeLog could not open',message(e));quitting=true;app.quit();}
});


