require("dotenv").config();
const express=require("express");
const path=require("path");
const crypto=require("crypto");
const Database=require("better-sqlite3");

const app=express();
const PORT=process.env.PORT||3000;
const BASE_URL=process.env.BASE_URL||`http://localhost:${PORT}`;
const OPENAI_API_KEY=process.env.OPENAI_API_KEY||"";
const OPENAI_MODEL=process.env.OPENAI_MODEL||"gpt-5.6-luna";
const META_VERIFY_TOKEN=process.env.META_VERIFY_TOKEN||"nexus-verify";
const META_APP_ID=process.env.META_APP_ID||"";
const META_APP_SECRET=process.env.META_APP_SECRET||"";
const META_REDIRECT_URI=process.env.META_REDIRECT_URI||`${BASE_URL}/api/meta/callback`;
const META_GRAPH_VERSION=process.env.META_GRAPH_VERSION||"v23.0";

const db=new Database(process.env.DB_PATH||"nexus.db");
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS agents(id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER,job TEXT,agent_name TEXT,business TEXT,channel TEXT,tone TEXT,knowledge TEXT,escalation TEXT,actions_json TEXT,system_prompt TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,agent_id INTEGER,external_id TEXT,direction TEXT,message TEXT,response TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS business_sources(id INTEGER PRIMARY KEY AUTOINCREMENT,agent_id INTEGER,url TEXT,source_type TEXT,raw_text TEXT,knowledge_json TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS channel_connections(id INTEGER PRIMARY KEY AUTOINCREMENT,agent_id INTEGER,channel TEXT,external_account_id TEXT,access_token TEXT,meta_json TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`);

app.use(express.json({limit:"4mb"}));
app.use(express.urlencoded({extended:true}));
app.use(express.static(__dirname));
app.get("/",(req,res)=>res.sendFile(path.join(__dirname,"index.html")));

const JOBS={
 sales:{name:"FOLLOWER",summary:"Qualifies new leads, answers approved questions, follows up and escalates high-intent conversations."},
 support:{name:"RECEPTION",summary:"Handles common customer questions, follows approved policies and escalates uncertain or sensitive cases."},
 booking:{name:"SCHEDULER",summary:"Collects booking details, checks configured rules and prepares or requests a booking action."},
 content:{name:"STUDIO",summary:"Turns approved business knowledge into platform-ready content while following the requested tone."},
 operations:{name:"ANALYST",summary:"Summarizes operational information, highlights exceptions and prepares human-review actions."}
};

function buildPrompt({business,job,channel,tone,knowledge,escalation,actions}){
 const j=JOBS[job]||JOBS.sales;
 return `You are ${j.name}, the AI customer-facing employee for ${business}.
JOB: ${j.summary}
CHANNEL: ${channel}
TONE: ${tone}
APPROVED ACTIONS: ${(actions||[]).join(", ")||"Reply to customers"}
ESCALATION: ${escalation}
BUSINESS KNOWLEDGE:\n${knowledge||"(No verified business knowledge supplied yet.)"}

RULES:
1. Only use verified business knowledge. Never invent prices, services, availability, policies, addresses, opening hours, guarantees, credentials or other facts.
2. If the answer is not in the verified knowledge, say you do not have that information yet and offer human help.
3. Answer the customer's actual question first. Do not talk about being an AI unless asked.
4. Keep replies natural, concise and channel-appropriate.
5. Use the customer's language when possible.
6. Never request passwords, payment-card numbers, security codes or unnecessary sensitive information.
7. Do not make irreversible commitments without a configured business rule or human approval.
8. If the customer shows buying intent, guide them to the next configured action.
`;
}

function upsertCustomer(name,email){
 const existing=db.prepare("SELECT * FROM customers WHERE email=?").get(email);
 if(existing){ if(name && name!==existing.name) db.prepare("UPDATE customers SET name=? WHERE id=?").run(name,existing.id); return db.prepare("SELECT * FROM customers WHERE id=?").get(existing.id); }
 const r=db.prepare("INSERT INTO customers(name,email) VALUES(?,?)").run(name||"NEXUS Test Customer",email);
 return db.prepare("SELECT * FROM customers WHERE id=?").get(r.lastInsertRowid);
}

function createAgent({customerId,business,job="sales",channel="Website chat",tone="Professional & friendly",knowledge="",escalation="Ask a human when unsure",actions=[]}){
 const chosen=JOBS[job]||JOBS.sales;
 const prompt=buildPrompt({business,job,channel,tone,knowledge,escalation,actions});
 const r=db.prepare(`INSERT INTO agents(customer_id,job,agent_name,business,channel,tone,knowledge,escalation,actions_json,system_prompt) VALUES(?,?,?,?,?,?,?,?,?,?)`)
   .run(customerId||null,job,chosen.name,business,channel,tone,knowledge,escalation,JSON.stringify(actions),prompt);
 return db.prepare("SELECT * FROM agents WHERE id=?").get(r.lastInsertRowid);
}

function normalizeUrl(input){
 let u;
 try{u=new URL(input); if(!/^https?:$/.test(u.protocol)) return null; u.hash=""; return u.toString();}catch{return null}
}
function sourceType(url){
 const h=new URL(url).hostname.toLowerCase();
 if(h.includes("instagram.com")) return "Instagram";
 if(h.includes("facebook.com")) return "Facebook";
 if(h.includes("whatsapp.com")) return "WhatsApp";
 return "Website";
}
function cleanText(s){return String(s||"").replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<noscript[\s\S]*?<\/noscript>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&#39;/gi,"'").replace(/&quot;/gi,'"').replace(/\s+/g," ").trim();}
function extractHtml(html,url){
 const title=(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||"";
 const desc=(html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([\s\S]*?)["']/i)||[])[1]||"";
 const ogTitle=(html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([\s\S]*?)["']/i)||[])[1]||"";
 const headings=[...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map(m=>cleanText(m[1])).filter(Boolean).slice(0,80);
 const body=cleanText(html).slice(0,30000);
 const links=[...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map(m=>({href:m[1],text:cleanText(m[2])})).filter(x=>x.text).slice(0,100);
 return {url,title:cleanText(title),description:cleanText(desc),ogTitle:cleanText(ogTitle),headings,body,links};
}
async function fetchPublicSource(url){
 const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),12000);
 try{
  const r=await fetch(url,{redirect:"follow",signal:controller.signal,headers:{"user-agent":"NEXUS-Business-Analyzer/1.0"}});
  const text=await r.text();
  return {status:r.status,contentType:r.headers.get("content-type")||"",finalUrl:r.url,text:text.slice(0,800000)};
 }finally{clearTimeout(timer)}
}
function buildKnowledge(parsed,url){
 const source=sourceType(url);
 return {
  sourceType:source,
  sourceUrl:url,
  businessName:parsed.ogTitle||parsed.title||new URL(url).hostname,
  description:parsed.description||"",
  headings:parsed.headings,
  pageText:parsed.body,
  usefulLinks:parsed.links.filter(x=>/menu|service|product|price|contact|location|about|book|shop|faq|hours/i.test(x.text+" "+x.href)).slice(0,40)
 };
}

async function answerWithAI(agent,message,channel){
 const knowledge=agent.knowledge||"";
 if(!OPENAI_API_KEY){
  return {response:`I’m ready to answer customers for ${agent.business}, but the live AI provider key is not configured on the server yet.`,live:false};
 }
 const input=`BUSINESS: ${agent.business}\nCHANNEL: ${channel||agent.channel}\nVERIFIED KNOWLEDGE:\n${knowledge}\n\nCUSTOMER MESSAGE:\n${message}`;
 const r=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${OPENAI_API_KEY}`},body:JSON.stringify({model:OPENAI_MODEL,instructions:agent.system_prompt,input,max_output_tokens:500})});
 const data=await r.json();
 if(!r.ok) throw new Error(data.error?.message||"OpenAI request failed");
 const text=data.output_text||data.output?.flatMap(x=>x.content||[]).map(x=>x.text||"").join(" ").trim();
 if(!text) throw new Error("AI returned an empty response");
 return {response:text,live:true,responseId:data.id};
}

app.get("/api/health",(req,res)=>res.json({ok:true,service:"nexus-ai-engine",aiConfigured:Boolean(OPENAI_API_KEY),metaConfigured:Boolean(META_APP_ID&&META_APP_SECRET),baseUrl:BASE_URL}));

app.post("/api/business/analyze",async(req,res)=>{
 const url=normalizeUrl(req.body?.url);
 if(!url) return res.status(400).json({error:"Enter a valid public http(s) URL."});
 try{
  const fetched=await fetchPublicSource(url);
  if(fetched.status>=400) return res.status(502).json({error:`Source returned HTTP ${fetched.status}.`});
  const parsed=extractHtml(fetched.text,fetched.finalUrl||url);
  const knowledge=buildKnowledge(parsed,fetched.finalUrl||url);
  res.json({ok:true,source:sourceType(url),fetchStatus:fetched.status,contentType:fetched.contentType,finalUrl:fetched.finalUrl||url,knowledge,notes:sourceType(url)==="Instagram"||sourceType(url)==="Facebook"?["Public profile HTML can be limited by the platform. For full account data and messaging, connect the account through Meta authorization."]:[]});
 }catch(e){res.status(502).json({error:"Could not read that public source. The account may require login or block automated access.",detail:process.env.NODE_ENV==="development"?e.message:undefined});}
});

app.post("/api/demo/activate",(req,res)=>{
 const {name="NEXUS Tester",email=`demo-${crypto.randomUUID()}@nexus.local`,business,channel="Instagram",job="support",knowledge="",tone="Professional & friendly",escalation="Ask a human when unsure",actions=[]}=req.body||{};
 if(!business) return res.status(400).json({error:"Business name required"});
 const customer=upsertCustomer(name,email);
 const agent=createAgent({customerId:customer.id,business,job,channel,tone,knowledge,escalation,actions});
 res.json({ok:true,mode:OPENAI_API_KEY?"live-ai":"engine-ready",token:crypto.randomBytes(24).toString("hex"),customer,agent:{id:agent.id,name:agent.agent_name,business:agent.business,channel:agent.channel}});
});

app.post("/api/agent/generate",(req,res)=>{
 const {customerId,business,job="sales",agent,channel="Website chat",tone="Professional & friendly",knowledge="",escalation="Ask a human when unsure",actions=[]}=req.body||{};
 if(!business) return res.status(400).json({error:"Business name required"});
 const chosen=JOBS[job]||JOBS.sales; const prompt=buildPrompt({business,job,channel,tone,knowledge,escalation,actions});
 let id=null;
 if(customerId) id=createAgent({customerId,business,job,channel,tone,knowledge,escalation,actions}).id;
 res.json({agentId:id,agentName:chosen.name,summary:chosen.summary,systemPrompt:prompt,status:"ready",aiConfigured:Boolean(OPENAI_API_KEY)});
});

app.post("/api/agent/chat",async(req,res)=>{
 const {agentId,message,channel}=req.body||{};
 if(!agentId||!message) return res.status(400).json({error:"agentId and message required"});
 const agent=db.prepare("SELECT * FROM agents WHERE id=?").get(agentId);
 if(!agent) return res.status(404).json({error:"Agent not found"});
 try{
  const result=await answerWithAI(agent,message,channel||agent.channel);
  db.prepare("INSERT INTO messages(agent_id,external_id,direction,message,response) VALUES(?,?,?,?,?)").run(agent.id,"chat-"+Date.now(),"inbound",message,result.response);
  res.json(result);
 }catch(e){res.status(502).json({error:e.message});}
});

app.post("/api/channel/inbound",async(req,res)=>{
 const {agentId,externalId,message,channel,customerRef}=req.body||{};
 if(!agentId||!message) return res.status(400).json({error:"agentId and message required"});
 const agent=db.prepare("SELECT * FROM agents WHERE id=?").get(agentId);
 if(!agent) return res.status(404).json({error:"Agent not found"});
 try{
  const result=await answerWithAI(agent,message,channel||agent.channel);
  db.prepare("INSERT INTO messages(agent_id,external_id,direction,message,response) VALUES(?,?,?,?,?)").run(agentId,externalId||"","inbound",message,result.response);
  res.json({status:"processed",mode:result.live?"live-ai":"engine-ready",agent:agent.agent_name,channel:channel||agent.channel,response:result.response,customerRef});
 }catch(e){res.status(502).json({error:e.message});}
});

/* Meta webhook verification */
app.get("/api/webhooks/meta",(req,res)=>{
 const mode=req.query["hub.mode"],token=req.query["hub.verify_token"],challenge=req.query["hub.challenge"];
 if(mode==="subscribe"&&token===META_VERIFY_TOKEN) return res.status(200).send(challenge);
 res.sendStatus(403);
});

/* Generic Meta inbound normalizer. The exact page/account mapping is completed after OAuth. */
app.post("/api/webhooks/meta",async(req,res)=>{
 res.sendStatus(200);
 try{
  const entries=req.body?.entry||[];
  for(const entry of entries){
   const messaging=entry.messaging||[];
   for(const event of messaging){
    const text=event.message?.text; if(!text) continue;
    const externalAccountId=String(entry.id||event.recipient?.id||"");
    const connection=db.prepare("SELECT * FROM channel_connections WHERE external_account_id=? ORDER BY id DESC LIMIT 1").get(externalAccountId);
    if(!connection) continue;
    const agent=db.prepare("SELECT * FROM agents WHERE id=?").get(connection.agent_id); if(!agent) continue;
    const result=await answerWithAI(agent,text,"Instagram/Facebook");
    db.prepare("INSERT INTO messages(agent_id,external_id,direction,message,response) VALUES(?,?,?,?,?)").run(agent.id,String(event.message?.mid||Date.now()),"inbound",text,result.response);
    /* Provider send-back is intentionally isolated here; configure the Meta connection first. */
    if(connection.access_token && META_GRAPH_VERSION){
      const senderId=event.sender?.id;
      if(senderId){
       const url=`https://graph.facebook.com/${META_GRAPH_VERSION}/${externalAccountId}/messages`;
       await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({recipient:{id:senderId},messaging_type:"RESPONSE",message:{text:result.response},access_token:connection.access_token})}).catch(()=>{});
      }
    }
   }
  }
 }catch(e){console.error("Meta webhook error",e);}
});

/* OAuth scaffold: only active when META_APP_ID/SECRET are configured. */
app.get("/api/meta/connect",(req,res)=>{
 if(!META_APP_ID) return res.status(503).send("Meta OAuth is not configured on this server yet.");
 const state=crypto.randomBytes(18).toString("hex");
 const scope=process.env.META_SCOPE||"instagram_business_basic,instagram_business_manage_messages,pages_show_list,pages_messaging";
 const u=new URL(`https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`);
 u.searchParams.set("client_id",META_APP_ID);u.searchParams.set("redirect_uri",META_REDIRECT_URI);u.searchParams.set("state",state);u.searchParams.set("scope",scope);
 res.redirect(u.toString());
});
app.get("/api/meta/callback",async(req,res)=>{
 if(!META_APP_ID||!META_APP_SECRET) return res.status(503).send("Meta OAuth is not configured.");
 const code=req.query.code; if(!code) return res.status(400).send("Missing OAuth code.");
 try{
  const u=new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token`);
  u.searchParams.set("client_id",META_APP_ID);u.searchParams.set("client_secret",META_APP_SECRET);u.searchParams.set("redirect_uri",META_REDIRECT_URI);u.searchParams.set("code",code);
  const r=await fetch(u); const data=await r.json(); if(!r.ok) throw new Error(data.error?.message||"Meta token exchange failed");
  /* The token is stored only after a real agent/account mapping is supplied. */
  res.send("NEXUS connected to Meta authorization. Return to your NEXUS workspace to finish selecting the business agent.");
 }catch(e){res.status(502).send("Meta connection failed: "+e.message);}
});

app.listen(PORT,()=>console.log(`NEXUS AI Engine running at ${BASE_URL}`));
