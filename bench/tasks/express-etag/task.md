Bug report:

After our latest deploy, CDN and proxy cache revalidation broke. Express is emitting strong ETags (e.g. `ETag: "5d8-nfsl..."`) even though Express ETags are supposed to default to weak (`W/"..."`) — and explicitly calling `app.set('etag', 'weak')` still produces strong ones. Meanwhile a sister service that uses `app.set('etag', 'strong')` is now getting weak ETags. Passing a custom etag function works correctly.

Find the root cause and fix it. Do not change the public API, and preserve the documented contract (default and `'weak'` produce weak ETags, `'strong'` produces strong ones, `false` disables, functions pass through). When you are done, state the root cause in one sentence.
