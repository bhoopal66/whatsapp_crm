import { describe, expect, it } from 'vitest';

import { stageTagLinkUpdates } from './stage-tag-links';

describe('stageTagLinkUpdates', () => {
  it('writes nothing when no link changed', () => {
    const stages = [
      { id: 'a', auto_chat_tag_id: 't1' },
      { id: 'b', auto_chat_tag_id: null },
      { id: 'c' },
    ];
    expect(stageTagLinkUpdates(stages, stages)).toEqual([]);
  });

  it('sets a new link', () => {
    expect(
      stageTagLinkUpdates(
        [{ id: 'a', auto_chat_tag_id: null }],
        [{ id: 'a', auto_chat_tag_id: 't1' }]
      )
    ).toEqual([{ stageId: 'a', tagId: 't1' }]);
  });

  it('clears a removed link', () => {
    expect(
      stageTagLinkUpdates(
        [{ id: 'a', auto_chat_tag_id: 't1' }],
        [{ id: 'a', auto_chat_tag_id: null }]
      )
    ).toEqual([{ stageId: 'a', tagId: null }]);
  });

  it('clears both stages before setting either when two swap tags', () => {
    const out = stageTagLinkUpdates(
      [
        { id: 'a', auto_chat_tag_id: 't1' },
        { id: 'b', auto_chat_tag_id: 't2' },
      ],
      [
        { id: 'a', auto_chat_tag_id: 't2' },
        { id: 'b', auto_chat_tag_id: 't1' },
      ]
    );
    expect(out).toEqual([
      { stageId: 'a', tagId: null },
      { stageId: 'b', tagId: null },
      { stageId: 'a', tagId: 't2' },
      { stageId: 'b', tagId: 't1' },
    ]);
  });

  it('clears the old holder before another stage takes the tag', () => {
    const out = stageTagLinkUpdates(
      [
        { id: 'a', auto_chat_tag_id: 't1' },
        { id: 'b', auto_chat_tag_id: null },
      ],
      [
        { id: 'a', auto_chat_tag_id: null },
        { id: 'b', auto_chat_tag_id: 't1' },
      ]
    );
    expect(out).toEqual([
      { stageId: 'a', tagId: null },
      { stageId: 'b', tagId: 't1' },
    ]);
  });

  it('treats a stage inserted this session as unlinked', () => {
    expect(
      stageTagLinkUpdates(
        [{ id: 'a' }],
        [{ id: 'a' }, { id: 'new', auto_chat_tag_id: 't1' }]
      )
    ).toEqual([{ stageId: 'new', tagId: 't1' }]);
    expect(
      stageTagLinkUpdates([{ id: 'a' }], [{ id: 'a' }, { id: 'new' }])
    ).toEqual([]);
  });
});
