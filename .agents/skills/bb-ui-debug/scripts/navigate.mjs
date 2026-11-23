import {open} from './bb-cdp.mjs';
const b=await open();
await b.send('Page.navigate',{url:process.argv[2]});
await b.sleep(2500);
console.log(await b.ev('location.href'));
b.close();
