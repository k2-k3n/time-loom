// Time Loom: what the controllers show and the CC each control sends (channel 1).
// src/loom_app.cpp binds the same numbers in kBind.
export const profile = {
  name: 'Time Loom',
  accent: '#ca4518',
  pages: [
    {key: 'P', label: 'PLAY', title: 'Weave', color: '#CA4518', controls: [
      {id: 'state', cc: 25, kind: 'readout', label: 'Loom', options: ['LIVE', 'CAPTURED', 'UNRAVEL', 'DRY']},
      {id: 'hold', cc: 30, kind: 'trigger', label: 'HOLD', key: 'A'},
      {id: 'stutter', cc: 31, kind: 'trigger', label: 'STUTTER', key: 'S'},
      {id: 'hush', cc: 32, kind: 'trigger', label: 'DRY', key: 'D'},
      {id: 'space', kind: 'xy', label: 'Tone × Repeats', x: 'tone', y: 'repeats'},
    ]},
    {key: 'L', label: 'LOOM', title: 'The loom', color: '#3B5A8C', controls: [
      {id: 'division', cc: 20, kind: 'choice', label: 'Phrase', options: ['1/1', '1/2', '1/4', '1/8', '1/16'], def: 3},
      {id: 'tone', cc: 21, kind: 'range', label: 'Tone', min: 0, max: 100, def: 55},
      {id: 'tail', cc: 22, kind: 'range', label: 'Tail', min: 0, max: 100, def: 45,
        format: v => `${(0.25 + 2.75 * v / 100).toFixed(2)} s`},
      {id: 'repeats', cc: 23, kind: 'range', label: 'Repeats', min: 0, max: 100, unit: '%', def: 80},
      {id: 'dry', cc: 24, kind: 'toggle', label: 'Dry compare', def: 0},
    ]},
  ],
};
