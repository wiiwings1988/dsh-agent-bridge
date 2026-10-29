#!/usr/bin/env python3
"""Stand-in for the Claude executable in e2e runs.

`-p <prompt>` (commit-message drafting): reads the diff from stdin and prints a fixed message.
Anything else is a session started by the SDK. While the mode file ($EE_FAKE_MODE, default
/tmp/ee-fake-mode) does not say "record", the call is passed through to the real executable
($EE_REAL_CLAUDE, default `claude` on PATH) so model lists and the like are real. In "record" mode it appends the argument list and the first stdin lines
to $EE_FAKE_LOG, then exits with an error, so the test can see exactly what the SDK was asked to do.
"""
import json, os, select, sys

REAL = os.environ.get('EE_REAL_CLAUDE', 'claude')
MODE = os.environ.get('EE_FAKE_MODE', '/tmp/ee-fake-mode')

args = sys.argv[1:]
if '-p' in args:
    sys.stdin.read()
    print('feat: drafted by fake claude')
    sys.exit(0)
try:
    mode = open(MODE).read().strip()
    record = mode in ('record', 'record-hold')
except OSError:
    mode = ''
    record = False
if not record:
    os.execvp(REAL, [REAL] + args)
lines = []
deadline = 1.5
while len(lines) < 6:
    ready, _, _ = select.select([sys.stdin], [], [], deadline)
    if not ready:
        break
    line = sys.stdin.readline()
    if line == '':
        break
    lines.append(line.rstrip('\n'))
    try:
        request = json.loads(line)
    except ValueError:
        request = {}
    if request.get('type') == 'control_request':
        # Answer the SDK's start-up handshake so it goes on to send the user message.
        reply = {'type': 'control_response', 'response': {'subtype': 'success', 'request_id': request.get('request_id'), 'response': {'commands': [], 'agents': [], 'output_style': 'default', 'available_output_styles': ['default'], 'models': [], 'account': {}}}}
        sys.stdout.write(json.dumps(reply) + '\n')
        sys.stdout.flush()
    if request.get('type') == 'user':
        break
    deadline = 6
with open(os.environ.get('EE_FAKE_LOG', '/tmp/ee-fake-claude.log'), 'a') as log:
    log.write(json.dumps({'args': args, 'stdin': lines}) + '\n')
if mode == 'record-hold':
    import time
    time.sleep(9)  # keeps the turn "running" long enough for a test to see it
sys.stderr.write('fake claude: refusing to run a turn\n')
sys.exit(1)
