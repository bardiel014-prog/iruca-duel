"""Duel aggregate counters. No visitor records, IPs, cookies or raw referrers."""
import collections, datetime as dt, json, os, re, sqlite3, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from contextlib import contextmanager

DB = os.environ.get('DUEL_METRICS_DB', '/var/lib/iruca-duel-metrics/counts.sqlite3')
VERSION = 'v20-a1'
@contextmanager
def connect(db=None):
    c = sqlite3.connect(db or DB, timeout=5)
    c.execute('CREATE TABLE IF NOT EXISTS counts(day TEXT,event TEXT,mode TEXT,hero INTEGER,cpu INTEGER,result TEXT,turn INTEGER,device TEXT,source TEXT,n INTEGER,PRIMARY KEY(day,event,mode,hero,cpu,result,turn,device,source))')
    c.execute('CREATE TABLE IF NOT EXISTS dedup(id TEXT PRIMARY KEY,ts INTEGER)')
    try:
        with c: yield c
    finally: c.close()

def validate(p):
    if not isinstance(p,dict) or set(p) != {'id','version','event','mode','hero','cpu','result','turn','device','source'}: raise ValueError()
    if not isinstance(p['id'],str) or not re.fullmatch(r'[a-f0-9-]{36}',p['id']): raise ValueError()
    if p['version'] != VERSION or p['event'] not in ('view','start','complete','quit'): raise ValueError()
    if p['device'] not in ('mobile','tablet','desktop') or p['source'] not in ('direct','internal','search','social','other'): raise ValueError()
    if type(p['hero']) is not int or type(p['cpu']) is not int or type(p['turn']) is not int: raise ValueError()
    if p['event']=='view':
        if (p['mode'],p['hero'],p['cpu'],p['result'],p['turn']) != ('none',-1,-1,'none',0): raise ValueError()
    else:
        if p['mode'] not in ('cpu','tutorial') or not 0<=p['hero']<6 or not 0<=p['cpu']<6 or not 1<=p['turn']<=10: raise ValueError()
        if p['event']=='complete':
            if p['result'] not in ('win','loss','draw'): raise ValueError()
        elif p['result']!='none': raise ValueError()
    return p

def record(p,db=None):
    p=validate(p); now=int(time.time()); day=dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).date()
    with connect(db) as c:
        c.execute('DELETE FROM dedup WHERE ts < ?', (now-86400,))
        c.execute('DELETE FROM counts WHERE day < ?', ((day-dt.timedelta(days=89)).isoformat(),))
        if c.execute('INSERT OR IGNORE INTO dedup VALUES (?,?)',(p['id'],now)).rowcount:
            values=[day.isoformat()]+[p[k] for k in ('event','mode','hero','cpu','result','turn','device','source')]
            c.execute('INSERT INTO counts VALUES (?,?,?,?,?,?,?,?,?,1) ON CONFLICT DO UPDATE SET n=n+1',values)

def report(db=None):
    cutoff=(dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).date()-dt.timedelta(days=89)).isoformat()
    with connect(db) as c:
        c.row_factory=sqlite3.Row
        return {'version':VERSION,'timezone':'Asia/Tokyo','retention_days':90,'rows':[dict(r) for r in c.execute('SELECT * FROM counts WHERE day>=? ORDER BY day DESC',(cutoff,))]}

def cleanup(db=None):
    day=dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).date()
    with connect(db) as c:
        c.execute('DELETE FROM dedup WHERE ts < ?', (int(time.time())-86400,))
        c.execute('DELETE FROM counts WHERE day < ?', ((day-dt.timedelta(days=89)).isoformat(),))

class Handler(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.0'
    requests=collections.deque()
    def log_message(self,*args): pass
    def setup(self):
        super().setup(); self.connection.settimeout(4)
    def reply(self,status,obj=None):
        raw=b'' if obj is None else json.dumps(obj,ensure_ascii=False).encode()
        self.send_response(status); self.send_header('Content-Type','application/json; charset=utf-8'); self.send_header('Cache-Control','no-store'); self.send_header('Content-Length',str(len(raw))); self.end_headers(); self.wfile.write(raw)
    def do_GET(self):
        if self.path=='/health': self.reply(200,{'ok':True})
        elif self.path=='/private/report': self.reply(200,report())
        elif self.path=='/private/test-report': self.reply(200,report(DB+'.test'))
        else: self.reply(404)
    def do_POST(self):
        if self.path not in ('/event','/test-event'): return self.reply(404)
        if self.headers.get('Origin')!='https://iruca.tech': return self.reply(403)
        if self.headers.get('Content-Type','').split(';')[0]!='application/json': return self.reply(415)
        now=time.monotonic()
        while self.requests and self.requests[0]<now-60: self.requests.popleft()
        if len(self.requests)>=1200: return self.reply(429)
        self.requests.append(now)
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<=1024: return self.reply(413)
            p=json.loads(self.rfile.read(length)); record(p,DB+'.test' if self.path=='/test-event' else None)
        except (ValueError,TypeError,UnicodeError): return self.reply(400)
        except sqlite3.Error: return self.reply(503)
        self.reply(204)

if __name__=='__main__':
    with connect(): pass
    server=HTTPServer(('127.0.0.1',8792),Handler); server.timeout=60
    last=0
    while True:
        if time.monotonic()-last>60: cleanup(); cleanup(DB+'.test'); last=time.monotonic()
        server.handle_request()
