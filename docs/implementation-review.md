# Implementation review

A fresh independent Codex reviewer examined the source, specification, manifests
and tests without reading the specification review verdict. Review covered the
runtime boundary, provider configuration, host instructions and installer. The
reviewer did not invoke live providers or install the host package.

## Findings and disposition

| Finding | Resolution and evidence |
| --- | --- |
| Repeating the model on Devin's first CLI prompt skips saved mode/effort replay in acpx 0.22.0 | Select and verify the model at creation; inherit it at submission. Persist requested controls, including already-current values. Production-adapter fixture verifies a non-default model, ask mode and high effort through empty-session replacement. Live comparison confirmed the interaction. |
| Resume can target an older integration turn after a direct upstream request | Compare public `lastRequestId` with the selected receipt immediately before submission. Reviewer independently reproduced the old behavior; the regression now fails closed. |
| One malformed receipt prevents all status inspection | Return normal scoped rows and explicit unknown receipt IDs for inspection. Mutation remains conservative when the damaged receipt's scope cannot be established, because it may represent a newer request. |

The final focused re-review found no unresolved P1/P2 findings. It independently
ran the production-adapter bootstrap regression through the real pinned acpx and
confirmed retained model/mode/effort and same-native continuation. The complete
suite and live-provider evidence are coordinator verification, not claims made by
the reviewer.

## Reviewed implementation fingerprints

The implementation was reviewed before its first code commit. SHA-256 identifies
the reviewed files independently of the later documentation/packaging commit:

```text
executions.mjs  e410a8369678374f4da9c9046747a2b4dd30f1962daa2265fe03fa4f395d86f1
providers.mjs   a7075beeb2151ef63155d2645e8985c63328568c1721ac70481f7971fcb3011a
runtime.mjs     d5070296a6de25084b175bd55398750fea616c77b1b5a1812c38f4cbff664541
preferences.mjs 1d3eea0a015788ccf0c9f00364a4cb44d6f1084048394a68ee6ab7b7a0351e18
rescue.mjs      8bb3cdbd1eaa2517084d318565e4cce8d0d94cd655107b85ee6afe8098829379
executions.test.mjs 6c40d8cd79c58bf1f1dfc147832f3d9c072a37875b33ec220b26a
fixtures/agent.mjs  4f1c3e6fb53273eeb4dd9d9e3cee68cb8f3bee8305e40eba4e266a8c55a514a5
```

Runtime modules are under `plugins/rescue/scripts/lib`; the CLI is under
`plugins/rescue/scripts`. Host discovery remains a manifest/path validation claim,
not an installed-host UI observation. See [compatibility](compatibility.md).
