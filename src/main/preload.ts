import {contextBridge,ipcRenderer} from 'electron';
const groups:Record<string,string[]>={entries:['save','delete'],timer:['start','stop'],projects:['save','remove','restore'],clients:['save','remove','restore'],tags:['save','delete'],reports:['get'],invoice:['preview','create','savePdf'],pomodoro:['start','pause','resume','dismiss','skip','stop','show'],settings:['save','clearNotice','testNotification'],data:['export','import','open']};
const api:any={state:{get:()=>ipcRenderer.invoke('timelog','state.get'),onChange:(fn:any)=>{const listener=(_:unknown,s:unknown)=>fn(s);ipcRenderer.on('state',listener);return()=>ipcRenderer.removeListener('state',listener);}}};
for(const [group,methods] of Object.entries(groups)){api[group]={};for(const method of methods)api[group][method]=(...args:unknown[])=>ipcRenderer.invoke('timelog',`${group}.${method}`,...args);}
contextBridge.exposeInMainWorld('api',api);

