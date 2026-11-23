import fs from 'fs';
export async function open(){
  const { wsEndpoint } = JSON.parse(fs.readFileSync(process.env.BB_CDP_FILE||'/tmp/bb-ui-debug/cdp.json','utf8'));
  const ws = new WebSocket(wsEndpoint); let id=0; const pend=new Map();
  const send=(method,params={},sessionId)=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method,params,sessionId}));});
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result);}};
  await new Promise(r=>ws.onopen=r);
  const {targetInfos}=await send('Target.getTargets');
  const t=targetInfos.find(t=>t.type==='page'||t.type==='tab');
  const {sessionId}=await send('Target.attachToTarget',{targetId:t.targetId,flatten:true});
  const ev=async(expression)=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);return r.result.value??r.exceptionDetails?.text;};
  const shot=async(f)=>{const s=await send('Page.captureScreenshot',{format:'png'},sessionId);fs.writeFileSync(f,Buffer.from(s.data,'base64'));};
  const click=async(x,y)=>{for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:1},sessionId);};
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  return {send:(m,p)=>send(m,p,sessionId),ev,shot,click,sleep,close:()=>ws.close()};
}
