"""Records the spoken lines for the family Secret Santa show (docs/family-santa/).

Microsoft neural voices through edge-tts (pip install edge-tts; no account):
  - the elf host (en-US-AnaNeural, a child's voice) says the drawing lines and each name
  - the Dala horse says "God Jul!" in Swedish (sv-SE-MattiasNeural)
  - Santa (en-US-GuyNeural, slowed and lowered) says "Ho ho ho! Merry Christmas!"
Rerun after changing NAMES (keep it in step with NAMES in docs/family-santa/index.html),
then bump VO_V in that page so phones don't keep the old recordings.
"""
import asyncio, os
import edge_tts

NAMES = ['Connie', 'John', 'Julie', 'Rick', 'Audrey', 'Haley', 'Brian', 'Rachel', 'Brad', 'Laurie', 'Rod', 'Nick']
ELF = ('en-US-AnaNeural', '+0%', '+0Hz')
SANTA = ('en-US-GuyNeural', '-14%', '-22Hz')
SWEDE = ('sv-SE-MattiasNeural', '-6%', '+0Hz')
OUT = os.path.join(os.path.dirname(__file__), '..', 'docs', 'family-santa', 'voice')


def lines():
    yield 'time', ELF, "It's time for the Secret Santa drawing!"
    yield 'goes-to', ELF, 'Your Secret Santa gift will go to...'
    yield 'godjul', SWEDE, 'God jul!'
    yield 'hohoho', SANTA, 'Ho! Ho! Ho! Merry Christmas!'
    for n in NAMES:
        yield 'name-' + n.lower(), ELF, n + '!'


async def main():
    os.makedirs(OUT, exist_ok=True)
    for key, (voice, rate, pitch), text in lines():
        path = os.path.join(OUT, key + '.mp3')
        for attempt in range(4):
            try:
                await edge_tts.Communicate(text, voice, rate=rate, pitch=pitch).save(path)
                print(f'{key}.mp3  {os.path.getsize(path):>6}  {text}')
                break
            except Exception as e:  # the service sometimes returns nothing; wait and retry
                print('retry', key, e)
                await asyncio.sleep(2)


if __name__ == '__main__':
    asyncio.run(main())
