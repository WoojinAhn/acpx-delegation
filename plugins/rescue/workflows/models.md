# Models and preferences

An explicit model ID bypasses discovery and preference lookup. The connected ACP
agent validates it before prompting. Resume inherits its recorded model and effort.
Never change the provider's own configuration or save a preference incidentally.

For a fresh task without an explicit model, read `preference PROVIDER show`.
If a preference exists, use the saved model/effort pair; unsupported saved choices
fail without substitution. With no preference, agy requires a picker. Grok and
Devin may use their native default, clearly labelled as such.

Use `models PROVIDER --filter TEXT --page N --limit 2` for bounded ACP discovery.
Show returned exact IDs and display names, including advertised reasoning controls.
Resolve natural-language model/effort requests using this live catalog. Ask if
ambiguous; a default or Auto/routing model requires explicit selection in agy.
No roster means offer an exact ID or cancellation, never an invented fallback.

Keep picker questions within the host's limit: one or two choices plus next/search
and cancel as space permits. Fetch only the requested page. Cancellation or a
dismissed required question changes nothing and submits no task.

After single-model selection, offer use once, save preference and use, or cancel.
Only the explicit save choice invokes `preference PROVIDER set MODEL` with optional
`--effort LEVEL`. Save failure is an error, not permission to choose a substitute.
Parallel model choices run once without changing a shared preference.

The standalone models operation supports browse/search, showing the preference,
explicit save, and explicit clear. Clear uses `preference PROVIDER clear` and
does not reset the vendor's settings. Exact IDs from old print-mode catalogs are
not silently rewritten into ACP IDs.
