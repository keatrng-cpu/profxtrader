#!/usr/bin/env python3
"""ai/memory/mem.py - auto-memory for Claude Code, Grok, Codex (any agent). stdlib only, fail-open.
  start [task]     NOW.md summary + relevant graph slice (Claude SessionStart hook / first command for others)
  slice "<task>"   graph slice for a task (graphify query, small budget) - never the whole GRAPH_REPORT
  route "<task>"   pick a model via forge-atlas router
  stop             append session log entry; nudge once if code changed but ai/NOW.md didn't (Claude Stop hook)
  post-commit      graphify update when the commit touched code files (installed by install-hook)
  install-hook     install .git/hooks/post-commit (chains an existing hook)"""
import json,os,shutil,subprocess as sp,sys,time
ROOT=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
REPO=os.path.basename(ROOT); AI=os.path.join(ROOT,'ai'); LOG=os.path.join(AI,'.sessions.log')
FA=os.environ.get('FORGE_ATLAS','/workspace/forge-atlas')
CODE=('.py','.js','.mjs','.cjs','.ts','.tsx','.jsx','.html','.css','.go','.rs','.java','.rb','.sh','.sql','.swift','.kt','.cs','.vue','.svelte','.md')
def sh(*a,**k):
  try: return sp.run(a,cwd=ROOT,capture_output=True,text=True,timeout=k.get('t',20)).stdout
  except Exception: return ''
def gbin():
  for b in (os.environ.get('GRAPHIFY_BIN'),'/workspace/.graphify-venv/bin/graphify'):
    if b and os.path.exists(b): return b
  return shutil.which('graphify')
def graph():
  for p in (f'{ROOT}/graphify-out/graph.json',f'{FA}/repos/{REPO}/graphify-out/graph.json'):
    if os.path.exists(p): return p
def read(p,n=None):
  try: return open(p,errors='ignore').read()[:n]
  except Exception: return ''
def changed():
  fs=set(sh('git','diff','--name-only','HEAD~3','HEAD').split())|{l[3:].strip() for l in sh('git','status','--porcelain','-uall').splitlines()}
  return [f for f in fs if f.endswith(CODE) and not f.startswith(('graphify-out/','ai/'))]
def slice_(task='',budget=450):
  g,b=graph(),gbin()
  if not (g and b): return '(no graph yet: run `graphify update .`)'
  seeds=[a for f in changed()[:4] for a in ('--seed',f)]
  out=sh(b,'query',task or 'recent changes',*seeds,'--budget',str(budget),'--graph',g,t=15) if (task or seeds) else ''
  if not out.strip() or out.startswith('No ') : out=sh(b,'god-nodes','--top','6','--graph',g,t=15)
  return out.strip()[:2400]
def summary():
  now=read(f'{AI}/NOW.md')
  if not now: return '(ai/NOW.md missing - create it at task end)'
  keep=[l for l in now.splitlines() if l.strip() and not l.startswith('---')][:45]
  return '\n'.join(keep)[:3000]
def last_decisions(k=3):
  ls=[l for l in read(f'{AI}/DECISIONS.md').splitlines() if l.startswith('## ')]
  return '\n'.join(ls[-k:])
def start(task=''):
  try: ev=json.loads(sys.stdin.read() or '{}') if not sys.stdin.isatty() else {}
  except Exception: ev={}
  txt=(f"# Auto-memory ({REPO})\n## ai/NOW.md (summary)\n{summary()}\n\n## Last decisions\n{last_decisions() or '(none)'}\n\n"
       f"## Graph slice (recent files; for your task run `python3 ai/memory/mem.py slice \"<task>\"`)\n{slice_(task)}\n\n"
       "End of task: overwrite ai/NOW.md with current truth, append ai/DECISIONS.md. Never write ai/HANDOFF.md.")
  if ev.get('hook_event_name')=='SessionStart': print(json.dumps({"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":txt}}))
  else: print(txt)
def route(task):
  r=f'{FA}/tools/route.py'
  if not os.path.exists(r): print('router unavailable: default Claude for code, Grok for research'); return
  print(sh(sys.executable,r,task,'--repo',REPO,'--files',*changed()[:8],t=20).strip())
def stop():
  try: ev=json.loads(sys.stdin.read() or '{}')
  except Exception: ev={}
  sid=ev.get('session_id','manual')[:12]; st=[l[3:].strip() for l in sh('git','status','--porcelain','-uall').splitlines()]
  head=sh('git','rev-parse','--short','HEAD').strip(); br=sh('git','branch','--show-current').strip()
  code=[f for f in st if not f.startswith(('ai/','graphify-out/'))]; now_t='ai/NOW.md' in st
  entry=f"{time.strftime('%Y-%m-%d %H:%M %Z')} session={sid} agent={ev.get('agent','claude' if ev else 'manual')} branch={br} head={head} dirty={len(st)} now_updated={'yes' if now_t else 'no'}"
  os.makedirs(AI,exist_ok=True); prev=[l for l in read(LOG).splitlines() if not l.startswith('nudged=')][-1:]
  key=entry.split(' ',3)[-1]
  if not prev or prev[0].split(' ',3)[-1]!=key: open(LOG,'a').write(entry+'\n')
  nudged=f'nudged={sid}' in read(LOG)
  if code and not now_t and not ev.get('stop_hook_active') and not nudged and ev:
    open(LOG,'a').write(f'nudged={sid}\n')
    print(json.dumps({"decision":"block","reason":"Memory protocol: before stopping, overwrite ai/NOW.md with current truth (short) and append one dated entry to ai/DECISIONS.md for any decision made. Do not touch ai/HANDOFF.md."}))
def post_commit():
  fs=sh('git','diff-tree','--no-commit-id','--name-only','-r','HEAD').split()
  fs=[f for f in fs if f.endswith(CODE) and not f.startswith(('graphify-out/','ai/'))]
  b=gbin()
  if not fs or not b: return
  out=f'{ROOT}/graphify-out'
  if not os.path.exists(f'{out}/graph.json') and os.path.exists(f'{FA}/repos/{REPO}/graphify-out/graph.json'):
    shutil.copytree(f'{FA}/repos/{REPO}/graphify-out',out,dirs_exist_ok=True)  # seed SHA256 cache
  os.makedirs(out,exist_ok=True)
  with open(f'{out}/.post-commit.log','a') as lg:
    lg.write(f"{time.strftime('%F %T')} {len(fs)} changed: {' '.join(fs[:10])}\n"); lg.flush()
    if os.environ.get('MEM_SYNC'): sp.run([b,'update','.'],cwd=ROOT,stdout=lg,stderr=lg)
    else: sp.Popen((['flock',f'{out}/.update.lock'] if shutil.which('flock') else [])+[b,'update','.'],cwd=ROOT,stdout=lg,stderr=lg,start_new_session=True)
def install_hook():
  gd=sh('git','rev-parse','--git-path','hooks').strip(); hp=os.path.join(ROOT,gd,'post-commit') if not os.path.isabs(gd) else os.path.join(gd,'post-commit')
  line='python3 "$(git rev-parse --show-toplevel)/ai/memory/mem.py" post-commit || true  # auto-memory\n'
  cur=read(hp)
  if 'auto-memory' in cur: print('already installed',hp); return
  os.makedirs(os.path.dirname(hp),exist_ok=True)
  open(hp,'w').write((cur if cur else '#!/bin/sh\n')+('' if cur.endswith('\n') or not cur else '\n')+line); os.chmod(hp,0o755)
  ex=os.path.join(ROOT,sh('git','rev-parse','--git-path','info/exclude').strip())
  if not sh('git','ls-files','graphify-out').strip() and 'graphify-out/' not in read(ex): open(ex,'a').write('\ngraphify-out/\n')
  print('installed',hp)
if __name__=='__main__':
  a=sys.argv[1:] or ['start']; c,arg=a[0],' '.join(a[1:])
  try: {'start':lambda:start(arg),'slice':lambda:print(slice_(arg)),'route':lambda:route(arg),'stop':stop,'post-commit':post_commit,'install-hook':install_hook}[c]()
  except KeyError: print(__doc__)
  except Exception as e: print(f'mem.py {c}: {e}',file=sys.stderr)
