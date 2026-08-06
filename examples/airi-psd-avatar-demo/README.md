# AIRI PSD Avatar Demo

This example reads `seethrough_output (1).psd` from the repository root in the browser and turns its named layers into a lightweight proxy rig. It does not generate a Cubism `.moc3` file.

## What it demonstrates

- AIRI-style cursor and idle gaze
- AIRI's 75 ms close / 225 ms open forced blink timing
- speech-like `ParamMouthOpenY` input
- breathing and body idle motion
- a transient beat response
- Cubism-compatible parameter names and ranges

## Run

```sh
pnpm -F @proj-airi/psd-avatar-demo dev
```

Open <http://127.0.0.1:4179>.

## PSD naming contract

The automatic mapper recognizes `mouth`, `eyebrow-*`, `eyewhite-*`, `irides-*`, `eyelash-*`, `face`, `nose`, `neck`, `ears-*`, `headwear`, `front hair`, and `back hair`. Unrecognized layers remain attached to the body.

For a better mouth result without drawing new art, duplicate the current mouth layer into closed/open variants and name them explicitly in a future mapping revision. True head turns and deformation still require Cubism ArtMesh/keyform authoring.
