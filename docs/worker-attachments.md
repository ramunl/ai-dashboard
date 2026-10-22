# Worker draft attachments

In Coding → Work, picking images shows small thumbnails immediately beneath
the text, before submission and without waiting for a server refresh. Pasted
images use the same preview. Each thumbnail shows its filename and a keyboard
accessible Remove button with a visible focus outline. Removing a thumbnail
removes that file from the pending upload; it does not send a server request.
Picking the same file again after removal works.

This checkout builds that draft in `coding-start.js`, not an existing
`coding-worker.js`. The new `coding-worker.js` connects the existing picker to
`attachment-preview.js`; both are loaded by `index.html`.

Previews use local object URLs, never base64 or an upload. URLs are released
when removed, on form reset, when the rendered editor is replaced or left,
and on pagehide. A restored page or rebuilt draft creates fresh URLs for
retained files. The Work draft still survives navigation in memory as before;
a full reload loses it. Successful submission clears the draft as before.
The current editor is a set of card rows, with no native reset button; the
preview also handles reset if it is hosted in a form.

Existing limits remain: three images, at most 5 MB each, with an image MIME
type. Plan/Implement still upload original files sequentially via multipart
POST /api/coding/images (field `image`), then send their IDs in the existing
create_task payload after confirmation. Bugfix does not accept images.
No backend, inbox or action allow-list changes are needed.

The filename remains visible during decoding. If object URLs are unavailable
or decoding fails, “Preview unavailable” stays visible alongside Remove.
A failed preview does not validate or reject the original upload.
CSS bounds the displayed image, but a large image can still consume browser
memory and decode slowly; object URLs avoid the extra base64 copy. The server
does not decode images for these previews.

## Verification

The six initial jsdom regressions were run against the old code and all failed
on missing immediate previews or URL cleanup. Tests cover immediate selection
with the input focused and refresh suppressed, removal and the unchanged
upload payload, reset, detached editors, pagehide/pageshow, and preview errors. Additional tests cover rebuilt editors, discarded render
results, and pasted images.
jsdom stubs object URLs and cannot verify real image decoding or WebView support.

Real Telegram client and 1 GB VPS-served page verification remains pending:
this coding environment provides neither an authenticated Telegram client nor
a deployed copy of the changed page. The supplied Ops snapshot is cached
historical evidence, not a live check. No service restart or deployment was run.

After normal deployment through Ops, check in Telegram on the target devices:
pick three images near the 5 MB limit while editing, confirm thumbnails appear
without submitting, remove/re-pick an image, navigate away/back, and submit
the remaining files. Check light/dark themes, keyboard focus, unsupported image
formats, responsiveness during decoding, and the network panel (selection
must not upload). Record client versions and observations; serving on a 1 GB
VPS alone cannot establish the client's decoding performance.
