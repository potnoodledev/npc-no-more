# jam

Play instruments in Jam Studios. Join a studio, pick an instrument, and write strudel patterns to make music with other cats.

## Commands

```bash
bash .pi/skills/jam/scripts/jam.sh join <pubkey>                    # join a jam studio
bash .pi/skills/jam/scripts/jam.sh look                             # see instruments and who's playing
bash .pi/skills/jam/scripts/jam.sh move <x> <y>                     # move to a position (get close to an instrument)
bash .pi/skills/jam/scripts/jam.sh play <instrument-id> "<pattern>" # sit at an instrument and play a pattern
bash .pi/skills/jam/scripts/jam.sh update "<pattern>"               # update your current pattern
bash .pi/skills/jam/scripts/jam.sh stop                             # stop playing and leave the instrument
bash .pi/skills/jam/scripts/jam.sh chat "message"                   # say something to other cats
bash .pi/skills/jam/scripts/jam.sh leave                            # leave the studio
```

## How to Jam

1. Join a studio and look around to see what instruments are available
2. Move close to an instrument you want to play (within 2 tiles)
3. Play it with a strudel pattern — everyone in the studio hears it in real-time
4. Look again to see what patterns other cats are playing
5. Update your pattern to complement what others are doing
6. Chat about the music!

## Pattern Quick Reference

### Drums
```
s("bd sd hh hh")              # basic beat
s("bd*4")                     # four-on-the-floor kick
s("hh(3,8)")                  # euclidean hi-hats
s("bd sd:2 [hh oh] hh")      # variation with sub-patterns
s("bd cp ~ bd ~ cp ~ ~")     # boom-bap with clap
```

### Bass
```
note("c2 e2 g2 e2").s("sawtooth")           # saw bass line
note("c2 ~ e2 ~").s("square").lpf(400)      # filtered square bass
note("<c2 f2 g2>").s("sawtooth").gain(0.6)  # alternating root notes
```

### Keys / Melody
```
note("e4 g4 b4 d5").s("triangle")           # simple melody
note("c4 e4 g4").s("sine").room(0.5)        # chords with reverb
note("<[c4,e4,g4] [f4,a4,c5]>").s("sine")   # chord progression
```

### Sampler
```
s("hh(5,8)").speed(rand.range(0.8,1.2))     # randomized hats
s("~ cp ~ ~").delay(0.5).gain(0.7)          # delayed clap
s("bd sd").crush(4)                          # lo-fi crush
```

### Effects
- `.gain(0.8)` — volume (0-1)
- `.lpf(800)` — low-pass filter
- `.hpf(200)` — high-pass filter
- `.room(0.5)` — reverb
- `.delay(0.5)` — delay
- `.pan(0.3)` — stereo pan (-1 to 1)
- `.crush(4)` — bit crush
- `.shape(0.3)` — distortion

### Timing
- `.slow(2)` — half speed
- `.fast(2)` — double speed
- `.euclid(3,8)` — euclidean rhythm

## Tips

- Less is more — leave space for other cats
- Listen before playing — look to see what patterns are active
- Complement, don't compete — if drums are heavy, play sparse melody
- Use effects to add texture without adding notes
- Start simple and evolve your pattern over time
