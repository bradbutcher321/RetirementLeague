"""Draws the family Secret Santa and writes the send list (one private link per person).

    python tools/family_santa_draw.py                      # nobody draws themselves
    python tools/family_santa_draw.py --not Connie,John --not Julie,Rick   # couples skip each other

Each link ends in a short code that holds who the person is and who they drew; the show page
(docs/family-santa/) reads it, so nothing about the draw is stored on the site or in git.
The send list is written OUTSIDE the repo (../family-santa-links.html) and the pairs are never
printed, so the person running this doesn't see them either. Running it again makes a NEW draw:
only do that before any links have gone out.
NAMES must match NAMES in docs/family-santa/index.html, in the same order.
"""
import argparse, base64, html, os, random, secrets, urllib.parse

NAMES = ['Connie', 'John', 'Julie', 'Rick', 'Audrey', 'Haley', 'Brian', 'Rachel', 'Brad', 'Laurie', 'Rod', 'Nick']
BASE = 'https://bradbutcher321.github.io/RetirementLeague/family-santa/'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'family-santa-links.html')


def code(g, x):
    r = secrets.randbelow(256)
    b = bytes([r, g ^ 0x5A ^ r, x ^ 0xC3 ^ r, (g * 7 + x * 13 + r * 3 + 11) & 255])
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()


def decode(tok):  # same check the page does
    b = base64.urlsafe_b64decode(tok + '=' * (-len(tok) % 4))
    r, g, x = b[0], b[1] ^ 0x5A ^ b[0], b[2] ^ 0xC3 ^ b[0]
    assert b[3] == (g * 7 + x * 13 + r * 3 + 11) & 255
    return g, x


def draw(blocked):
    rng = random.SystemRandom()
    for _ in range(100000):
        order = NAMES[:]
        rng.shuffle(order)
        pairs = {order[i]: order[(i + 1) % len(order)] for i in range(len(order))}  # one big loop
        if all(frozenset((a, b)) not in blocked for a, b in pairs.items()):
            return pairs
    raise SystemExit('No draw works with those --not rules.')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--not', dest='nots', action='append', default=[], help='two names that must not draw each other, e.g. Connie,John')
    a = ap.parse_args()
    blocked = set()
    for n in a.nots:
        x, y = [s.strip().title() for s in n.split(',')]
        assert x in NAMES and y in NAMES, f'unknown name in {n}'
        blocked.add(frozenset((x, y)))
    pairs = draw(blocked)
    rows = []
    for giver in NAMES:
        tok = code(NAMES.index(giver), NAMES.index(pairs[giver]))
        assert decode(tok) == (NAMES.index(giver), NAMES.index(pairs[giver]))
        url = BASE + '#' + tok
        msg = (f"🎅 Hi {giver}! Here's your Secret Santa video. Tap the link, turn your sound up, "
               f"and press and hold the envelope. It's just for you, so don't share it! {url}")
        rows.append(f"""<tr><td class="n">{html.escape(giver)}</td>
<td><a class="b" href="sms:&body={urllib.parse.quote(msg)}">💬 Text</a>
<button class="b" data-m="{html.escape(msg)}">📋 Copy</button><span class="ok"></span></td></tr>""")
    page = f"""<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Secret Santa send list</title>
<style>body{{font:18px system-ui,sans-serif;margin:20px;max-width:640px}} td{{padding:10px 6px;border-bottom:1px solid #ddd}}
.n{{font-weight:700;width:30%}} .b{{display:inline-block;font:inherit;padding:10px 14px;margin:2px;border-radius:10px;border:1px solid #bbb;background:#f6f6f6;color:#000;text-decoration:none}}
.ok{{color:#1f7a4c;font-weight:700;margin-left:6px}} p{{color:#555}}</style>
<h1>🎅 Secret Santa send list</h1>
<p>Send each person ONLY their own row. Each message has their private link. Don't open other people's links, because that shows who they drew.
On an iPhone, "Text" opens Messages with the note filled in; pick the person and send.
Rules: nobody gets themselves{(" + " + ", ".join(" & ".join(sorted(b)) + " skip each other" for b in blocked)) if blocked else ""}.</p>
<table>{''.join(rows)}</table>
<script>document.querySelectorAll('button[data-m]').forEach(b=>b.onclick=()=>navigator.clipboard.writeText(b.dataset.m).then(()=>b.nextElementSibling.textContent='Copied'));</script>
"""
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(page)
    print('Drew', len(NAMES), 'people; every link checked. Send list:', os.path.abspath(OUT))


if __name__ == '__main__':
    main()
