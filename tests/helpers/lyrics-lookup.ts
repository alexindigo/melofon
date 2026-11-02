import type { LyricsEntry } from '../../src/lyrics.ts';
import { lookupManifest, lookupPlugin } from './lookup.ts';

/** Test-only producer: the production plugin set gains no lyrics provider. */
export const lookupLyrics: LyricsEntry[] = [
  { language: 'eng', synced: false, lines: [{ text: 'Online plain' }] },
  {
    language: 'rus',
    synced: true,
    offset: -75,
    artist: 'Исполнитель',
    title: 'Песня',
    lines: [{
      text: 'Привет 🌍',
      start: 1000,
      cues: [
        { start: 1000, end: 1500, text: 'Привет ', byteStart: 0, byteEnd: 12 },
        { start: 1500, text: '🌍', byteStart: 13, byteEnd: 16 },
      ],
    }],
  },
  { language: 'eng', synced: false, lines: [{ text: 'Another version' }] },
];

export async function lyricsLookupPlugin(
  root: string,
  id = 'lyrics-fixture',
  requires: string[] = [],
  lyrics: LyricsEntry[] = lookupLyrics,
) {
  return await lookupPlugin(
    root,
    `export default { async lyrics(item, ctx) {
    const behavior = ctx.settings.behavior;
    if (behavior === 'error') throw new Error('lyrics fixture failed');
    if (behavior === 'empty') return {candidates:[]};
    if (behavior === 'retry') return {retryAfter:30,reason:'fixture busy'};
    if (behavior === 'network') await (await ctx.fetch('https://fixture.test/lyrics')).text();
    const entries = ${JSON.stringify(lyrics)};
    if (entries[1]?.offset !== undefined) entries[1].offset += ctx.settings.shift;
    if (behavior === 'oversize') entries[0].lines[0].text = 'x'.repeat(10000);
    const proposal = {
      target:{type:'track',id:behavior === 'foreign' ? 'foreign' : item.id},
      confidence:ctx.settings.confidence,
      values:{'track.lyrics':{url:'https://provenance.invalid/song',entries}},
      ids:{fixture:'external-song'},
      evidence:{facts:item,lyrics:'untrusted evidence must not replace the payload'}
    };
    if (behavior === 'malformed') return {candidates:[proposal,{
      ...proposal,values:{'track.lyrics':{url:'https://provenance.invalid/bad',
      entries:[{language:'eng',synced:true,lines:[{start:-1,text:'bad'}]}]}}
    }]};
    return {candidates:[proposal]};
  }};`,
    id,
    lookupManifest({
      capabilities: [{
        id: 'lyrics',
        accepts: 'track',
        provides: ['track.lyrics'],
        requires,
      }],
      settings: {
        type: 'object',
        properties: {
          behavior: { type: 'string', default: 'found' },
          shift: { type: 'integer', default: 0 },
          confidence: { type: 'string', default: 'strong' },
        },
      },
    }),
  );
}
