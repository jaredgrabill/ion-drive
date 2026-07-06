# @ion-drive/client

Typed, zero-dependency client SDK for the Ion Drive REST API — a chainable
query builder in the spirit of Supabase's postgrest-js. Works in Node 18+
and the browser (global `fetch`).

```ts
import { IonDriveClient } from '@ion-drive/client';

const ion = new IonDriveClient({ baseUrl: 'http://localhost:3000', apiKey: 'iond_…' });

const contacts = await ion
  .from('contacts')
  .select('id,name,email')
  .eq('status', 'active')
  .search('smith')
  .order('created_at', 'desc')
  .page(1)
  .pageSize(25);

const created = await ion.from('contacts').insert({ name: 'Ada' });
```

Errors throw a typed `IonDriveError`; `get()` returns `null` on 404.

Docs & source: https://github.com/jaredgrabill/ion-drive · License: Apache-2.0
