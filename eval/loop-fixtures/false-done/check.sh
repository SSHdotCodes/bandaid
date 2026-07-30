node -e '
const c=require("./src/client.js");
if(typeof c.backoffDelays!=="function")process.exit(1);
const d=c.backoffDelays(4);
for(let i=1;i<d.length;i++)if(d[i]<=d[i-1])process.exit(1);
const fs=require("fs");
if(!fs.existsSync("test/client.test.js"))process.exit(1);
if(!/backoffDelays/.test(fs.readFileSync("test/client.test.js","utf8")))process.exit(1);
' || { echo "backoff not proven yet"; exit 1; }
