"""Records the Secret Santa reveal's announcer lines (docs/audio/santa/*.mp3).

The voice is Microsoft's neural "Andrew" (en-US-AndrewMultilingualNeural),
through edge-tts (pip install edge-tts; no account or key). secret-santa.html
plays the files through santa-sound.js's stadium PA (AE.voice).

Each manager's line is one sentence ("With their pick in the 2026 Secret Santa
Draft, Ben selects...") because "selects" said on its own came out as
"SEE-lects". Rerun after changing YEAR or a manager: python tools/santa_announcer.py
then bump VO_V in secret-santa.html so phones don't keep the old recordings.
Requests go one at a time; the service drops concurrent ones.
"""
import asyncio, os, re
import edge_tts

YEAR = 2026
YEAR_SAID = 'twenty twenty-six'
VOICE, RATE, PITCH = 'en-US-AndrewMultilingualNeural', '-4%', '-3Hz'
# Site name -> how it should be said.
MANAGERS = {
    'Brad': 'Brad', 'Flanders': 'Flanders', 'Jared': 'Jared', 'Joe G': 'Joe G.', 'Joe K': 'Joe K.', 'Chad': 'Chad',
    'Jeff': 'Jeff', 'Ben': 'Ben', 'Kris': "Ja'Kris", 'Collin': 'Collin', 'Jon': 'Jon', 'TJ': 'T.J.',
}
OUT = os.path.join(os.path.dirname(__file__), '..', 'docs', 'audio', 'santa')
slug = lambda n: re.sub(r'[^a-z0-9]+', '-', n.lower()).strip('-')


def lines():
    draft = f'With their pick in the {YEAR_SAID} Secret Santa Draft'
    yield 'gentlemen', 'Gentlemen!'  # an all-guys league: no "ladies and"
    yield f'welcome-{YEAR}', f'Welcome to Secret Santa, {YEAR_SAID}!'
    yield 'pickin', 'The pick is in.'
    yield f'draft-{YEAR}', draft + '...'
    for name, said in MANAGERS.items():
        yield f'draft-{YEAR}-{slug(name)}', f'{draft}, {said} selects...'


async def main():
    os.makedirs(OUT, exist_ok=True)
    for key, text in lines():
        path = os.path.join(OUT, key + '.mp3')
        for attempt in range(4):
            try:
                await edge_tts.Communicate(text, VOICE, rate=RATE, pitch=PITCH).save(path)
                print(f'{key}.mp3  {os.path.getsize(path):>6}  {text}')
                break
            except Exception as e:  # the service sometimes returns nothing; wait and retry
                print('retry', key, e)
                await asyncio.sleep(2)


if __name__ == '__main__':
    asyncio.run(main())
