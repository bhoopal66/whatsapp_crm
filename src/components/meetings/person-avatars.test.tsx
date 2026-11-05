import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PersonAvatar } from './person-avatars';

const person = { userId: 'u1', avatarUrl: null };

describe('PersonAvatar', () => {
  it('takes the initials from the name', () => {
    const html = renderToStaticMarkup(
      <PersonAvatar person={{ ...person, name: 'Sara Ahmed' }} />
    );
    expect(html).toContain('>SA<');
  });

  it('keeps the real initials when the label is "You"', () => {
    const html = renderToStaticMarkup(
      <PersonAvatar
        person={{ ...person, name: 'You', initialsName: 'Hala Host' }}
      />
    );
    expect(html).toContain('>HH<');
  });
});
