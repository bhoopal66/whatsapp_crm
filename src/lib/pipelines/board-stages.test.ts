import { describe, expect, it } from 'vitest';
import type { PipelineStage } from '@/types';
import {
  boardStages,
  resolveSelectedPipeline,
  splitPipelineRows,
  unknownStagesRefreshKey,
  type PipelineWithStages,
} from './board-stages';

function stage(id: string, position: number): PipelineStage {
  return {
    id,
    pipeline_id: 'p1',
    name: id,
    position,
    color: '#000',
    auto_chat_tag_id: null,
    created_at: '2026-10-01T00:00:00Z',
  };
}

describe('boardStages', () => {
  it('gives a deal on a stage the held list lacks a column', () => {
    // Admin B added "Docs" and moved deals into it; A's held stage list
    // predates it. The deals must still be drawn.
    const held = [stage('new', 0), stage('won', 1)];
    const deals = [
      { stage_id: 'new' },
      { stage_id: 'docs' },
      { stage_id: 'docs' },
    ];
    const out = boardStages(held, deals, 'Updating');
    expect(out.unknownStageIds).toEqual(['docs']);
    expect(out.stages.map((s) => s.id)).toEqual(['new', 'won', 'docs']);
    const docs = out.stages[2];
    expect(docs.name).toBe('Updating');
    expect(docs.position).toBeGreaterThan(1);
    expect(docs.pipeline_id).toBe('p1');
  });

  it('every deal has a column', () => {
    const deals = [{ stage_id: 'a' }, { stage_id: 'b' }, { stage_id: 'c' }];
    const ids = new Set(
      boardStages([stage('a', 0)], deals, 'x').stages.map((s) => s.id)
    );
    for (const d of deals) expect(ids.has(d.stage_id)).toBe(true);
  });

  it('adds nothing when every stage is known', () => {
    const held = [stage('a', 0), stage('b', 1)];
    const out = boardStages(held, [{ stage_id: 'b' }], 'x');
    expect(out.unknownStageIds).toEqual([]);
    expect(out.stages).toEqual(held);
  });
});

describe('unknownStagesRefreshKey', () => {
  it('re-reads once per distinct set of unknown stages', () => {
    const first = unknownStagesRefreshKey(['b', 'a'], null);
    expect(first).toBe('a,b');
    expect(unknownStagesRefreshKey(['a', 'b'], first)).toBeNull();
    expect(unknownStagesRefreshKey(['c'], first)).toBe('c');
    expect(unknownStagesRefreshKey([], null)).toBeNull();
  });
});

describe('splitPipelineRows', () => {
  it('splits the list from the embedded stages', () => {
    const rows = [
      { id: 'p1', name: 'Sales', pipeline_stages: [stage('a', 0)] },
      { id: 'p2', name: 'Empty', pipeline_stages: null },
    ] as unknown as PipelineWithStages[];
    const { pipelines, stagesByPipeline } = splitPipelineRows(rows);
    expect(pipelines.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(pipelines[0]).not.toHaveProperty('pipeline_stages');
    expect(stagesByPipeline.get('p1')?.map((s) => s.id)).toEqual(['a']);
    expect(stagesByPipeline.get('p2')).toEqual([]);
  });
});

describe('resolveSelectedPipeline', () => {
  const list = [{ id: 'p1' }, { id: 'p2' }];
  it('keeps the chosen pipeline while it exists', () => {
    expect(resolveSelectedPipeline('p2', list)).toBe('p2');
  });
  it('falls back to the first, or none', () => {
    expect(resolveSelectedPipeline('', list)).toBe('p1');
    expect(resolveSelectedPipeline('gone', list)).toBe('p1');
    expect(resolveSelectedPipeline('p1', [])).toBe('');
  });
});
