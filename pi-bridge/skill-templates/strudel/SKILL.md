# Strudel — Live-Coding Music Patterns

You can create music using **Strudel**, a browser-based live-coding environment. Instead of generating audio files, you write pattern code and share it as a URL. Anyone clicking the link hears the music instantly at strudel.cc.

## Workflow

1. Write your pattern code to a `.js` file
2. Run the helper script to get a shareable URL:
   ```bash
   node skill-templates/strudel/scripts/strudel-link.js my-pattern.js
   ```
3. The script prints a `https://strudel.cc/#...` URL
4. Share the URL — post it on Nostr so followers can listen

## Pattern Syntax

Strudel patterns are JavaScript. The core functions are:

### Playing sounds

```js
// Trigger samples by name
s("bd hh sd hh")

// Trigger synth waveforms
s("sawtooth square triangle sine")

// Combine notes with sounds
note("a3 c#4 e4 a4").s("sawtooth")
```

Built-in samples: `bd` (bass drum), `sd` (snare), `hh` (hihat), `cp` (clap), `oh` (open hat), `lt` `mt` `ht` (toms), `cb` (cowbell), `cr` (crash), `ri` (ride).

Built-in synths: `sine`, `sawtooth`, `square`, `triangle`, `white`, `pink`, `brown` (noise).

### Mini notation (inside quotes)

| Syntax | Meaning | Example |
|--------|---------|---------|
| spaces | sequence events in a cycle | `"bd sd hh hh"` |
| `*N` | repeat N times per cycle | `"hh*8"` |
| `/N` | slow down over N cycles | `"[bd sd]/2"` |
| `[a b]` | subsequence (group) | `"bd [hh hh] sd hh"` |
| `<a b>` | alternate each cycle | `"<bd sd>"` |
| `~` | rest / silence | `"bd ~ sd ~"` |
| `,` | stack (play simultaneously) | `"bd sd, hh*4"` |
| `(k,n)` | euclidean rhythm | `"hh(3,8)"` |
| `!N` | replicate | `"bd!3 sd"` = `"bd bd bd sd"` |

### Notes and scales

```js
// Letter notation
note("c3 e3 g3 b3")

// MIDI numbers
note("48 52 55 59")

// Scale helper
n("0 2 4 6").scale("C:minor")

// Chords with voicings
"Am7 Dm7 G7 Cmaj7".voicings('lefthand').note()
```

### Effects (chain with dots)

```js
s("bd sd")
  .lpf(800)        // low-pass filter cutoff Hz
  .hpf(200)        // high-pass filter cutoff Hz
  .gain(0.8)       // volume 0-1
  .room(0.5)       // reverb amount
  .roomsize(4)     // reverb size
  .delay(0.25)     // delay amount
  .pan("0 1")      // stereo panning
  .distort(0.3)    // distortion
  .vowel("a e i")  // vowel filter
  .crush(4)        // bit crush
  .shape(0.5)      // waveshaping
  .attack(0.1)     // fade in time
  .decay(0.2)      // decay time
  .sustain(0.5)    // sustain level
  .release(0.3)    // fade out time
```

### Time modifiers

```js
.slow(2)     // half speed (same as /2 in mini notation)
.fast(2)     // double speed (same as *2)
.rev()       // reverse pattern
.early(0.25) // shift earlier
.late(0.25)  // shift later
.euclid(3,8) // euclidean distribution
```

### Stacking layers

Use `stack()` to layer multiple patterns:

```js
stack(
  s("bd sd"),      // drums
  note("c3 e3"),   // bass
  note("e4 g4")    // lead
)
```

Use `$:` prefix for multiple independent patterns (each on its own line):

```js
$: s("bd*2, ~ sd, hh*8")
$: note("<c3 a2 f2 g2>").s("sawtooth").lpf(800)
```

### Signals (continuous values)

```js
sine       // 0 to 1 sine wave
cosine     // cosine wave
saw        // sawtooth 0 to 1
tri        // triangle wave
perlin     // smooth random
irand(n)   // random integer 0 to n-1
rand       // random 0-1

// Use with .range() to map values
.lpf(sine.slow(4).range(200, 4000))
```

## Example Patterns

### Techno kick + hat

```js
stack(
  s("bd*4").gain(0.8),
  s("~ hh*2 ~ hh*3").gain(0.4),
  s("~ ~ cp ~").room(0.3)
).fast(1.2)
```

### Ambient pad

```js
note("<C3 Eb3 G3 Bb3>")
  .s("sawtooth")
  .lpf(sine.slow(8).range(300, 2000))
  .gain(0.3)
  .room(0.8)
  .roomsize(8)
  .attack(0.5)
  .decay(2)
  .sustain(0.6)
  .release(1)
  .slow(2)
```

### Lo-fi beat

```js
stack(
  s("bd ~ [~ bd] ~, ~ sd ~ sd").gain(0.7),
  s("hh*8").gain("0.4 0.2 0.3 0.2").lpf(3000),
  note("<[e3 ~] [g3 a3] [e3 d3] [c3 ~]>")
    .s("triangle")
    .lpf(800)
    .decay(0.3).sustain(0)
    .gain(0.5)
).slow(1.2)
```

### Drum & Bass

```js
stack(
  s("[bd ~ ~ bd] [~ ~ bd ~] [bd ~ ~ ~] [~ bd ~ ~]").gain(0.9),
  s("~ sd ~ [~ sd]").room(0.2),
  s("hh*16").gain(sine.range(0.1, 0.4)).pan(rand)
).fast(1.75)
```

### Jazz chords

```js
stack(
  "<Am7!3 <Em7 E7b13>>".voicings('lefthand')
    .note().s("sawtooth")
    .gain(0.15).cutoff(500).attack(0.8),
  s("ride*4").gain(0.2),
  s("[~ bd] [~ bd:1] [~ bd] [bd:1 ~]").gain(0.4)
).slow(1.5)
```

### Chiptune

```js
stack(
  note("[c5 e5 g5 e5]*2")
    .s("square")
    .lpf(2000).gain(0.3)
    .decay(0.1).sustain(0),
  note("<c3 g2 a2 f2>*2")
    .s("square")
    .lpf(600).gain(0.4)
    .decay(0.15).sustain(0),
  s("bd sd bd [sd bd]")
    .gain(0.5)
).fast(1.5)
```

### Full track (from Strudel docs)

```js
samples({
  bd: ['bd/BT0AADA.wav','bd/BT0AAD0.wav'],
  sd: ['sd/rytm-01-classic.wav','sd/rytm-00-hard.wav'],
  hh: ['hh27/000_hh27closedhh.wav','hh/000_hh3closedhh.wav'],
}, 'github:tidalcycles/dirt-samples');
stack(
  s("bd,[~ <sd!3 sd(3,4,2)>],hh*8")
    .speed(perlin.range(.7,.9)),
  "<a1 b1*2 a1(3,8) e2>"
    .off(1/8,x=>x.add(12).degradeBy(.5))
    .add(perlin.range(0,.5))
    .superimpose(add(.05))
    .note()
    .decay(.15).sustain(0)
    .s('sawtooth')
    .gain(.4)
    .cutoff(sine.slow(7).range(300,5000)),
  "<Am7!3 <Em7 E7b13 Em7 Ebm7b5>>".voicings('lefthand')
    .superimpose(x=>x.add(.04))
    .add(perlin.range(0,.5))
    .note()
    .s('sawtooth')
    .gain(.16)
    .cutoff(500)
    .attack(1)
).slow(3/2)
```

## Tips

- Keep patterns short and musical — complex doesn't mean better
- Use `.slow()` to give patterns room to breathe
- Layer 2-4 elements with `stack()` for full tracks
- Effects like `.room()` and `.delay()` add space and depth
- Use `perlin` and `rand` for organic variation
- Test in the strudel.cc REPL before posting
- When posting on Nostr, include a brief description of the vibe/genre along with the link
- To tag another user, use `@DisplayName` (e.g. `@Lyra Vox check this out`)
