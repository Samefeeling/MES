import { describe, expect, it } from 'vitest';
import { SharePointDataLayer } from '../src/dal/sharepoint';

// A sign-off lands without a value SharePoint refuses, rather than fail
// outright — and used to say so only in the console. A shift's Quality
// Check sign-offs could vanish behind a "Signed off" toast.

type Body = Record<string, unknown>;

function dalRefusing(refuse: (body: Body) => string | null) {
  const dal = new SharePointDataLayer({
    siteUrl: 'https://example.sharepoint.com/sites/x',
    canWrite: () => true,
  });
  const o = dal as unknown as {
    post: (url: string, body: Body, ifMatch?: string) => Promise<void>;
    postWithFieldRetry: (list: string, url: string, body: Body, ifMatch?: string) => Promise<void>;
    stripRejectedFields: (list: string, body: Body) => void;
  };
  const posts: Body[] = [];
  o.post = async (_url, body) => {
    posts.push(body);
    const error = refuse(body);
    if (error) throw new Error(error);
  };
  return { dal, o, posts };
}

const QC = JSON.stringify(Object.fromEntries(Array.from({ length: 16 }, (_, i) => [i, 'Bounpanh Wattanakone'])));
const row = (extra: Body = {}): Body => ({
  __metadata: { type: 'SP.Data.MockListItem' },
  Title: 'Batt2',
  CountStart: 0,
  CountEnd: 100,
  ...extra,
});

describe('what a sign-off could not save is reported', () => {
  it('names a Quality Checks map too long for its column', async () => {
    expect(QC.length).toBeGreaterThan(255);
    const { dal, o, posts } = dalRefusing((b) =>
      'QualityChecks' in b ? 'POST 500 Invalid text value. A text field contains invalid data.' : null,
    );
    await o.postWithFieldRetry('PMD_Production', 'https://x/items', row({ QualityChecks: QC }), '*');

    // The row landed without it, as before…
    expect('QualityChecks' in posts[posts.length - 1]).toBe(false);
    // …and now the sheet can say so.
    const lost = dal.takeWriteWarnings();
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatch(/^QualityChecks — .*Multiple lines of text/);
    // Told once: asking again has nothing new.
    expect(dal.takeWriteWarnings()).toEqual([]);
  });

  it('names a value with a character SharePoint refuses', async () => {
    const { dal, o } = dalRefusing((b) =>
      'Handover' in b ? 'POST 500 Invalid text value. A text field contains invalid data.' : null,
    );
    await o.postWithFieldRetry('PMD_Production', 'https://x/items', row({ Handover: 'Machine: ok' }), '*');
    expect(dal.takeWriteWarnings()).toEqual([
      'Handover — it holds a character SharePoint refuses: clear the field and type it again',
    ]);
  });

  it('says a mistyped column again on every sign-off that drops it', async () => {
    const { dal, o } = dalRefusing((b) =>
      'Reopened' in b ? "POST 400 Cannot convert a primitive value to the expected type 'Edm.String'." : null,
    );
    await o.postWithFieldRetry('PMD_Production', 'https://x/items', row({ Reopened: false }), '*');
    expect(dal.takeWriteWarnings()).toEqual(['Reopened — the column is typed as text, not Yes/No']);

    // The column is now banned and stripped before the next write goes out:
    // no refusal comes back, and the value is lost all the same.
    const next = row({ Reopened: false });
    o.stripRejectedFields('PMD_Production', next);
    expect('Reopened' in next).toBe(false);
    expect(dal.takeWriteWarnings()).toEqual(['Reopened — the column is typed as text, not Yes/No']);
  });

  it('says nothing about a column the tenant simply does not have', async () => {
    const { dal, o } = dalRefusing((b) =>
      'Cavities' in b ? "POST 400 The property 'Cavities' does not exist on type 'SP.Data.MockListItem'." : null,
    );
    await o.postWithFieldRetry('PMD_Production', 'https://x/items', row({ Cavities: 2 }), '*');
    expect(dal.takeWriteWarnings()).toEqual([]);
  });

  it('says nothing about the live mirror, which is not the record', async () => {
    const { dal, o } = dalRefusing((b) =>
      'QualityChecks' in b ? 'POST 500 Invalid text value. A text field contains invalid data.' : null,
    );
    await o.postWithFieldRetry('PMD_LiveStatus', 'https://x/items', row({ QualityChecks: QC }), '*');
    expect(dal.takeWriteWarnings()).toEqual([]);
  });
});
