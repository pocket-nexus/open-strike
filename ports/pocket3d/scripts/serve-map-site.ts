import { resolve, sep } from "node:path";
import { statSync } from "node:fs";
const root=resolve(Bun.argv[2]??"dist/map-site");
const port=Number(Bun.argv[3]??4174);
const server=Bun.serve({hostname:"127.0.0.1",port,async fetch(request){
  let pathname:string;
  try{pathname=decodeURIComponent(new URL(request.url).pathname);}catch{return new Response("Bad path",{status:400});}
  const path=resolve(root,"."+pathname+(pathname.endsWith("/")?"index.html":""));
  if(!path.startsWith(root+sep))return new Response("Not found",{status:404});
  try{if(!statSync(path).isFile())return new Response("Not found",{status:404});}catch{return new Response("Not found",{status:404});}
  return new Response(Bun.file(path),{headers:{"Cache-Control":"no-cache"}});
}});
console.log(`OpenStrike map viewer: http://${server.hostname}:${server.port}`);
