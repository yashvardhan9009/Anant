import { describe, it, expect } from 'vitest';
import { initialStory, applyDialogue, revealableFacts, NPC_BY_ID, secretGateOpen, accuse } from '../shared/story';
import { npcReply, offlineReply, buildNpcPrompt } from '../server/npc';
import { NebiusClient } from '../server/nebius';
import { FACT_BY_ID } from '../shared/story';

const offline = new NebiusClient({ baseUrl: 'x', timeoutMs: 100 });
const fakeLlm = (content: string) => new NebiusClient({ apiKey: 'k', baseUrl: 'https://e.test/v1', model: 'nvidia/NVIDIA-Nemotron-Nano-9B-v2', timeoutMs: 1000 }, (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }))) as any);

describe('story truth model', () => {
  it('Seren hides her secrets until the gate opens', () => {
    const s = initialStory();
    expect(revealableFacts(NPC_BY_ID.seren, s)).not.toContain('seren_took');
    s.playerKnows.push('cloaked_figure', 'moonleaf_only_seren');
    expect(secretGateOpen(NPC_BY_ID.seren, s)).toBe(true);
    expect(revealableFacts(NPC_BY_ID.seren, s)).toContain('crown_in_well');
  });

  it('the prompt never contains secret text before the gate opens', () => {
    const s = initialStory();
    const p = buildNpcPrompt(NPC_BY_ID.seren, s);
    expect(p).not.toContain(FACT_BY_ID.crown_in_well.text);
    expect(p).not.toContain(FACT_BY_ID.seren_took.text);
    expect(p).toMatch(/HIDING SOMETHING/);
  });

  it('applyDialogue rejects reveals an NPC cannot make, clamps disposition, logs transcript', () => {
    const s = initialStory();
    const r = applyDialogue(s, 'maera', 'hi', { speech: 'Hello!', emotion: 'warm', disposition_delta: 999, reveals: ['doran_alibi', 'crown_in_well', 'made_up'] }, 'test');
    expect(r.accepted).toEqual(['doran_alibi']);
    expect(r.rejected).toEqual(['crown_in_well', 'made_up']);
    expect(r.story.npcs.maera.disposition).toBe(30);
    expect(r.story.transcript).toHaveLength(2);
    expect(s.playerKnows).not.toContain('doran_alibi'); // input not mutated
  });

  it('LLM reveal of a gated secret is dropped server-side', async () => {
    const llm = fakeLlm('{"speech":"I took it and hid it in the well.","emotion":"scared","disposition_delta":3,"reveals":["seren_took","crown_in_well"]}');
    const r = await npcReply('seren', 'Did you take it?', initialStory(), llm);
    expect(r.source).toBe('nemotron');
    expect(r.outcome.reveals).toEqual([]);
    expect(r.droppedReveals).toEqual(['seren_took', 'crown_in_well']);
  });

  it('offline dialogue: detective path leads to the confession', async () => {
    let s = initialStory();
    const talk = async (npc: string, line: string) => {
      const r = await npcReply(npc, line, s, offline);
      expect(r.source).toBe('offline-dialogue');
      s = applyDialogue(s, npc, line, r.outcome, r.source).story;
      return r.outcome;
    };
    expect((await talk('seren', 'Where is the crown?')).reveals).toEqual([]);
    await talk('doran', 'Did you see anything last night?');
    await talk('maera', 'Who grows moonleaf?');
    expect(s.playerKnows).toEqual(expect.arrayContaining(['cloaked_figure', 'moonleaf_only_seren']));
    const conf = await talk('seren', 'Someone smelling of moonleaf went to the well. I know it was you.');
    expect(conf.reveals).toContain('crown_in_well');
    const { story } = accuse(s, 'seren');
    expect(story.outcome?.kind).toBe('truth_revealed');
  });

  it('accusing without proof has consequences', () => {
    const { story } = accuse(initialStory(), 'seren');
    expect(story.outcome?.kind).toBe('accused_without_proof');
    expect(story.npcs.seren.disposition).toBeLessThan(0);
  });

  it('rudeness lowers disposition offline', () => {
    expect(offlineReply(NPC_BY_ID.doran, 'you are a liar', initialStory()).disposition_delta).toBeLessThan(0);
  });
});
