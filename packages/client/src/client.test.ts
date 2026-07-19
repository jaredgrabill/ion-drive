import { describe, expect, it } from 'vitest';
import { IonDriveClient, IonDriveError } from './client.js';

/** Builds a fake `fetch` that records calls and returns a canned response. */
function fakeFetch(response: {
  status?: number;
  json?: unknown;
  body?: string;
}): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const status = response.status ?? 200;
    const text =
      response.body ?? (response.json !== undefined ? JSON.stringify(response.json) : '');
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    } as Response;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const listBody = (rows: unknown[], totalCount = rows.length) => ({
  data: rows,
  pagination: {
    page: 1,
    pageSize: 25,
    totalCount,
    totalPages: 1,
    hasNextPage: false,
    hasPreviousPage: false,
  },
});

describe('IonDriveClient — fluent reads', () => {
  it('is awaitable: await runs the list and builds the URL + API key header', async () => {
    const { fetch, calls } = fakeFetch({ json: listBody([{ id: '1' }]) });
    const ion = new IonDriveClient({ baseUrl: 'http://x:3000/', apiKey: 'iond_abc', fetch });

    const { data } = await ion
      .from('contacts')
      .select('id, full_name')
      .search('acme')
      .neq('status', 'archived')
      .order('created_at', { ascending: false });

    expect(data).toEqual([{ id: '1' }]);
    const call = calls[0];
    expect(call?.url.startsWith('http://x:3000/api/v1/data/contacts?')).toBe(true);
    const qs = new URLSearchParams(call?.url.split('?')[1]);
    expect(qs.get('search')).toBe('acme');
    expect(qs.get('status[neq]')).toBe('archived');
    expect(qs.get('sort')).toBe('-created_at');
    expect(qs.get('select')).toBe('id,full_name');
    expect((call?.init.headers as Record<string, string>)['x-api-key']).toBe('iond_abc');
  });

  it('range() maps to offset + limit', async () => {
    const { fetch, calls } = fakeFetch({ json: listBody([]) });
    const ion = new IonDriveClient({ baseUrl: 'http://x:3000', fetch });
    await ion.from('contacts').select().range(0, 24);
    const qs = new URLSearchParams(calls[0]?.url.split('?')[1]);
    expect(qs.get('offset')).toBe('0');
    expect(qs.get('limit')).toBe('25');
  });

  it('match() expands to equality filters', async () => {
    const { fetch, calls } = fakeFetch({ json: listBody([]) });
    const ion = new IonDriveClient({ baseUrl: 'http://x:3000', fetch });
    await ion.from('contacts').select().match({ status: 'active', tier: 'gold' });
    const qs = new URLSearchParams(calls[0]?.url.split('?')[1]);
    expect(qs.get('status')).toBe('active');
    expect(qs.get('tier')).toBe('gold');
  });

  it('single() returns the row when exactly one matches', async () => {
    const { fetch } = fakeFetch({ json: listBody([{ id: '1' }], 1) });
    const ion = new IonDriveClient({ baseUrl: 'http://x:3000', fetch });
    expect(await ion.from('contacts').select().eq('id', '1').single()).toEqual({ id: '1' });
  });

  it('single() throws when zero or multiple rows match', async () => {
    const none = new IonDriveClient({
      baseUrl: 'http://x:3000',
      fetch: fakeFetch({ json: listBody([], 0) }).fetch,
    });
    await expect(none.from('contacts').select().single()).rejects.toMatchObject({ status: 404 });

    const many = new IonDriveClient({
      baseUrl: 'http://x:3000',
      fetch: fakeFetch({ json: listBody([{ id: '1' }, { id: '2' }], 2) }).fetch,
    });
    await expect(many.from('contacts').select().single()).rejects.toMatchObject({ status: 400 });
  });

  it('aggregate() hits /aggregate with fn/field plus the chained conditions', async () => {
    const { fetch, calls } = fakeFetch({
      json: { data: { fn: 'avg', field: 'damage_dealt', value: 1234.5, filteredCount: 812 } },
    });
    const ion = new IonDriveClient({ baseUrl: 'http://x:3000', fetch });

    const result = await ion
      .from('players')
      .query()
      .gte('match_count', 10)
      .search('clan')
      .aggregate('avg', 'damage_dealt');

    expect(result).toEqual({ fn: 'avg', field: 'damage_dealt', value: 1234.5, filteredCount: 812 });
    const call = calls[0];
    expect(call?.url.startsWith('http://x:3000/api/v1/data/players/aggregate?')).toBe(true);
    const qs = new URLSearchParams(call?.url.split('?')[1]);
    expect(qs.get('fn')).toBe('avg');
    expect(qs.get('field')).toBe('damage_dealt');
    expect(qs.get('match_count[gte]')).toBe('10');
    expect(qs.get('search')).toBe('clan');
  });

  it('aggregate() omits field for a bare count', async () => {
    const { fetch, calls } = fakeFetch({
      json: { data: { fn: 'count', field: null, value: 3, filteredCount: 3 } },
    });
    const ion = new IonDriveClient({ baseUrl: 'http://x:3000', fetch });
    const result = await ion.from('players').query().aggregate('count');
    expect(result.filteredCount).toBe(3);
    const qs = new URLSearchParams(calls[0]?.url.split('?')[1]);
    expect(qs.get('fn')).toBe('count');
    expect(qs.has('field')).toBe(false);
  });

  it('count() returns the filtered count (the rank-pattern building block)', async () => {
    const { fetch, calls } = fakeFetch({
      json: { data: { fn: 'count', field: null, value: 1237, filteredCount: 1237 } },
    });
    const ion = new IonDriveClient({ baseUrl: 'http://x:3000', fetch });
    const rank = (await ion.from('players').query().gt('wins', 42).count()) + 1;
    expect(rank).toBe(1238);
    const qs = new URLSearchParams(calls[0]?.url.split('?')[1]);
    expect(qs.get('wins[gt]')).toBe('42');
    expect(qs.get('fn')).toBe('count');
  });

  it('maybeSingle() returns null for none and throws for multiple', async () => {
    const none = new IonDriveClient({
      baseUrl: 'http://x:3000',
      fetch: fakeFetch({ json: listBody([], 0) }).fetch,
    });
    expect(await none.from('contacts').select().maybeSingle()).toBeNull();

    const many = new IonDriveClient({
      baseUrl: 'http://x:3000',
      fetch: fakeFetch({ json: listBody([{ id: '1' }, { id: '2' }], 2) }).fetch,
    });
    await expect(many.from('contacts').select().maybeSingle()).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('IonDriveClient — writes', () => {
  it('insert(record) unwraps the { data } envelope', async () => {
    const { fetch, calls } = fakeFetch({
      status: 201,
      json: { data: { id: '9', full_name: 'Ada' } },
    });
    const ion = new IonDriveClient({ baseUrl: 'http://x:3000', fetch });
    const created = await ion.from('contacts').insert({ full_name: 'Ada' });
    expect(created).toEqual({ id: '9', full_name: 'Ada' });
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.url.endsWith('/api/v1/data/contacts')).toBe(true);
  });

  it('insert(records[]) hits the bulk endpoint and returns a summary', async () => {
    const { fetch, calls } = fakeFetch({ status: 201, json: { count: 2, ids: ['a', 'b'] } });
    const ion = new IonDriveClient({ baseUrl: 'http://x:3000', fetch });
    const result = await ion.from('contacts').insert([{ full_name: 'A' }, { full_name: 'B' }]);
    expect(result).toEqual({ count: 2, ids: ['a', 'b'] });
    expect(calls[0]?.url.endsWith('/api/v1/data/contacts/bulk')).toBe(true);
  });

  it('get() returns null on a 404', async () => {
    const { fetch } = fakeFetch({ status: 404, json: { message: 'nope' } });
    const ion = new IonDriveClient({ baseUrl: 'http://x:3000', fetch });
    expect(await ion.from('contacts').get('missing')).toBeNull();
  });

  it('treats a 204 delete as success', async () => {
    const { fetch } = fakeFetch({ status: 204 });
    const ion = new IonDriveClient({ baseUrl: 'http://x:3000', fetch });
    expect(await ion.from('contacts').delete('1')).toBe(true);
  });

  it('throws IonDriveError with the server message on other errors', async () => {
    const { fetch } = fakeFetch({ status: 400, json: { message: 'bad field' } });
    const ion = new IonDriveClient({ baseUrl: 'http://x:3000', fetch });
    await expect(ion.from('contacts').select()).rejects.toMatchObject({
      name: 'IonDriveError',
      status: 400,
      message: 'bad field',
    });
  });

  it('exposes IonDriveError for callers', () => {
    expect(new IonDriveError('x', 500).status).toBe(500);
  });
});

describe('IonDriveClient — m2m links (Phase 13)', () => {
  it('link() POSTs the ids to the links path and unwraps the count', async () => {
    const { fetch, calls } = fakeFetch({ json: { data: { added: 2 } } });
    const ion = new IonDriveClient({ baseUrl: 'http://x:3000', fetch });

    const result = await ion.from('contacts').link('c1', 'tags', ['t1', 't2']);

    expect(result).toEqual({ added: 2 });
    expect(calls[0]?.url).toBe('http://x:3000/api/v1/data/contacts/c1/links/tags');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ ids: ['t1', 't2'] });
  });

  it('unlink() DELETEs the ids and unwraps the count', async () => {
    const { fetch, calls } = fakeFetch({ json: { data: { removed: 1 } } });
    const ion = new IonDriveClient({ baseUrl: 'http://x:3000', fetch });

    const result = await ion.from('contacts').unlink('c1', 'tags', ['t1']);

    expect(result).toEqual({ removed: 1 });
    expect(calls[0]?.init.method).toBe('DELETE');
    expect(calls[0]?.url).toContain('/contacts/c1/links/tags');
  });

  it('surfaces link errors as IonDriveError with the server message', async () => {
    const { fetch } = fakeFetch({
      status: 400,
      json: { error: 'NOT_MANY_TO_MANY', message: 'Relationship "company" is not many_to_many' },
    });
    const ion = new IonDriveClient({ baseUrl: 'http://x:3000', fetch });

    const err = await ion
      .from('contacts')
      .link('c1', 'company', ['x'])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IonDriveError);
    expect((err as IonDriveError).message).toContain('not many_to_many');
    expect((err as IonDriveError).status).toBe(400);
  });
});

describe('IonDriveClient — atomic increments + upsert (issue #9)', () => {
  it('update() passes $inc operator values through the PATCH body', async () => {
    const { fetch, calls } = fakeFetch({ json: { data: { id: '1', wins: 5 } } });
    const ion = new IonDriveClient({ baseUrl: 'http://x:3000', fetch });

    const row = await ion.from('player_stats').update('1', { wins: { $inc: 1 } });

    expect(row).toEqual({ id: '1', wins: 5 });
    expect(calls[0]?.init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ wins: { $inc: 1 } });
  });

  it('increment() sugars fields into $inc operators', async () => {
    const { fetch, calls } = fakeFetch({ json: { data: { id: '1', wins: 5, losses: 2 } } });
    const ion = new IonDriveClient({ baseUrl: 'http://x:3000', fetch });

    await ion.from('player_stats').increment('1', { wins: 1, losses: -1 });

    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      wins: { $inc: 1 },
      losses: { $inc: -1 },
    });
  });

  it('upsert() POSTs with on_conflict and returns the { data, created } envelope', async () => {
    const { fetch, calls } = fakeFetch({
      json: { data: { id: '1', device_id: 'abc' }, created: false },
    });
    const ion = new IonDriveClient({ baseUrl: 'http://x:3000', fetch });

    const result = await ion
      .from('devices')
      .upsert({ device_id: 'abc' }, { onConflict: ['room_code', 'seed'] });

    expect(result).toEqual({ data: { id: '1', device_id: 'abc' }, created: false });
    const call = calls[0];
    expect(call?.init.method).toBe('POST');
    expect(call?.url).toContain('/api/v1/data/devices?on_conflict=room_code%2Cseed');
  });

  it('upsert() accepts a single-column onConflict string', async () => {
    const { fetch, calls } = fakeFetch({ json: { data: { id: '1' }, created: true } });
    const ion = new IonDriveClient({ baseUrl: 'http://x:3000', fetch });

    const result = await ion
      .from('devices')
      .upsert({ device_id: 'abc' }, { onConflict: 'device_id' });

    expect(result.created).toBe(true);
    expect(calls[0]?.url).toContain('on_conflict=device_id');
  });
});
