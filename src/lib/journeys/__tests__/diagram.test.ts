import { describe, expect, it } from 'vitest';
import { SHIPPED_WORKFLOW, toMermaid } from '../index';

describe('workflow diagram', () => {
  // Replaces the package's `npm run diagram`. After editing the workflow, regenerate with:
  //   npx vitest run src/lib/journeys/__tests__/diagram.test.ts -u
  it('docs/journey-bot-flow.mmd is the diagram generated from the shipped workflow', async () => {
    await expect(toMermaid(SHIPPED_WORKFLOW)).toMatchFileSnapshot(
      '../../../../docs/journey-bot-flow.mmd'
    );
  });
});
