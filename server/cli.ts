import { resolve } from 'node:path';
import { createApp } from './app.js';
const app=createApp({dbPath:process.env.DB_PATH||resolve('data/chess.sqlite'),clientDir:resolve('dist/client'),allowedOrigin:process.env.WEB_ORIGIN});
const port=await app.listen(Number(process.env.PORT||3002),process.env.HOST||'127.0.0.1');
console.log(JSON.stringify({event:'listening',port}));
for(const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>{void app.close().then(()=>process.exit(0));});
